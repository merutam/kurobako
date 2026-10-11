//! Holds the X11 selection for what ksync puts on the clipboard. x11-clipboard
//! answers every type asked of it with the one thing it holds, so a program
//! asking an image for its text (a clipboard history, as GNOME's do) got the
//! PNG's bytes as text. Here each type offered is answered, and any other is
//! refused, as the ICCCM asks.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use bytes::Bytes;
use x11rb::{
    COPY_DEPTH_FROM_PARENT,
    COPY_FROM_PARENT,
    CURRENT_TIME,
    NONE,
    connection::{Connection, RequestConnection as _},
    errors::ReplyOrIdError,
    protocol::{
        Event,
        xproto::{
            Atom,
            AtomEnum,
            ChangeWindowAttributesAux,
            ConnectionExt as _,
            CreateWindowAux,
            EventMask,
            PropMode,
            Property,
            SELECTION_NOTIFY_EVENT,
            SelectionNotifyEvent,
            SelectionRequestEvent,
            Window,
            WindowClass,
        },
    },
    rust_connection::RustConnection,
    wrapper::ConnectionExt as _,
};

use crate::clipboard::ClipboardError;

/// The bytes on offer, and the types they are offered as.
pub struct Offer {
    pub targets: Vec<Atom>,
    pub bytes: Bytes,
}

/// What each selection (CLIPBOARD, PRIMARY) is offering, while ksync owns it.
type Offers = Arc<Mutex<HashMap<Atom, Offer>>>;

pub struct Owner {
    connection: Arc<RustConnection>,
    window: Window,
    offers: Offers,
}

#[derive(Clone, Copy)]
struct Atoms {
    targets: Atom,
    incr: Atom,
}

/// Contents larger than one request go in parts (INCR): the requestor deletes
/// each part to ask for the next, and an empty one ends them.
struct Transfer {
    target: Atom,
    bytes: Bytes,
    sent: usize,
}

const INCR_CHUNK_BYTES: usize = 256 * 1024;

impl Owner {
    pub fn new() -> Result<Self, ClipboardError> {
        let (connection, screen) = x11rb::connect(None)?;
        let (window, atoms) = setup(&connection, screen)?;
        let connection = Arc::new(connection);
        let offers = Offers::default();

        let serving = (Arc::clone(&connection), Arc::clone(&offers));
        std::thread::spawn(move || serve(&serving.0, atoms, &serving.1));

        Ok(Self {
            connection,
            window,
            offers,
        })
    }

    pub fn atom(&self, name: &str) -> Result<Atom, ClipboardError> {
        Ok(intern(&self.connection, name)?)
    }

    /// Puts `offer` on `selection`, ksync's until another program takes it.
    pub fn offer(&self, selection: Atom, offer: Offer) -> Result<(), ClipboardError> {
        self.offers
            .lock()
            .expect("not poisoned")
            .insert(selection, offer);
        if claim(&self.connection, self.window, selection)? {
            Ok(())
        } else {
            Err(ClipboardError::NotOwner)
        }
    }
}

fn intern(connection: &RustConnection, name: &str) -> Result<Atom, ReplyOrIdError> {
    Ok(connection.intern_atom(false, name.as_bytes())?.reply()?.atom)
}

/// An unmapped window to own selections with.
fn setup(connection: &RustConnection, screen: usize) -> Result<(Window, Atoms), ReplyOrIdError> {
    let root = connection.setup().roots[screen].root;
    let window = connection.generate_id()?;
    connection.create_window(
        COPY_DEPTH_FROM_PARENT,
        window,
        root,
        0,
        0,
        1,
        1,
        0,
        WindowClass::INPUT_OUTPUT,
        COPY_FROM_PARENT,
        &CreateWindowAux::new(),
    )?;
    let atoms = Atoms {
        targets: intern(connection, "TARGETS")?,
        incr: intern(connection, "INCR")?,
    };
    connection.flush()?;
    Ok((window, atoms))
}

fn claim(connection: &RustConnection, window: Window, selection: Atom) -> Result<bool, ReplyOrIdError> {
    connection
        .set_selection_owner(window, selection, CURRENT_TIME)?
        .check()?;
    Ok(connection.get_selection_owner(selection)?.reply()?.owner == window)
}

fn serve(connection: &RustConnection, atoms: Atoms, offers: &Offers) {
    // A property, its header aside, holds at most one request's bytes.
    let max_bytes = connection.maximum_request_bytes().saturating_sub(64);
    let mut transfers = HashMap::<(Window, Atom), Transfer>::new();
    loop {
        let event = match connection.wait_for_event() {
            Ok(event) => event,
            Err(err) => {
                tracing::warn!("X11 clipboard owner stopped: {err}");
                return;
            }
        };
        match event {
            Event::SelectionRequest(request) => {
                let property = answer(connection, atoms, offers, &request, max_bytes, &mut transfers)
                    .unwrap_or(NONE);
                let notify = SelectionNotifyEvent {
                    response_type: SELECTION_NOTIFY_EVENT,
                    sequence: 0,
                    time: request.time,
                    requestor: request.requestor,
                    selection: request.selection,
                    target: request.target,
                    property,
                };
                let _ = connection.send_event(false, request.requestor, EventMask::NO_EVENT, notify);
                let _ = connection.flush();
            }

            Event::PropertyNotify(event) if event.state == Property::DELETE => {
                let key = (event.window, event.atom);
                let Some(transfer) = transfers.get_mut(&key) else {
                    continue;
                };
                let end = (transfer.sent + INCR_CHUNK_BYTES).min(transfer.bytes.len());
                let _ = connection.change_property8(
                    PropMode::REPLACE,
                    event.window,
                    event.atom,
                    transfer.target,
                    &transfer.bytes[transfer.sent..end],
                );
                if end == transfer.sent {
                    // That was the empty part: the transfer is over.
                    transfers.remove(&key);
                } else {
                    transfer.sent = end;
                }
                let _ = connection.flush();
            }

            Event::SelectionClear(event) => {
                offers
                    .lock()
                    .expect("not poisoned")
                    .remove(&event.selection);
            }

            _ => {}
        }
    }
}

/// Writes what `request` asks for; the property it is in, or None to refuse.
fn answer(
    connection: &RustConnection,
    atoms: Atoms,
    offers: &Offers,
    request: &SelectionRequestEvent,
    max_bytes: usize,
    transfers: &mut HashMap<(Window, Atom), Transfer>,
) -> Option<Atom> {
    // Requestors from before ICCCM 2 name no property: the target is one.
    let property = if request.property == NONE {
        request.target
    } else {
        request.property
    };
    let offers = offers.lock().expect("not poisoned");
    let offer = offers.get(&request.selection)?;

    if request.target == atoms.targets {
        let mut targets = vec![atoms.targets];
        targets.extend(&offer.targets);
        connection
            .change_property32(PropMode::REPLACE, request.requestor, property, AtomEnum::ATOM, &targets)
            .ok()?;
        return Some(property);
    }

    if !offer.targets.contains(&request.target) {
        return None;
    }

    if offer.bytes.len() <= max_bytes {
        connection
            .change_property8(PropMode::REPLACE, request.requestor, property, request.target, &offer.bytes)
            .ok()?;
    } else {
        // Told of each deletion of the property, to send the next part then.
        connection
            .change_window_attributes(
                request.requestor,
                &ChangeWindowAttributesAux::new().event_mask(EventMask::PROPERTY_CHANGE),
            )
            .ok()?;
        let size = u32::try_from(offer.bytes.len()).unwrap_or(u32::MAX);
        connection
            .change_property32(PropMode::REPLACE, request.requestor, property, atoms.incr, &[size])
            .ok()?;
        transfers.insert(
            (request.requestor, property),
            Transfer {
                target: request.target,
                bytes: offer.bytes.clone(),
                sent: 0,
            },
        );
    }
    Some(property)
}
