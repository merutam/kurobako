# Garage 2.1.0

Garage is an optional, separate S3-compatible storage service. Kurobako's
Podman Compose setup builds a Garage image from `dxflrs/garage:v2.1.0`, and the
`with-garage` Nix app runs the Garage package alongside Kurobako. Garage is not
linked into the application and can be replaced by another S3-compatible
service.

Garage is licensed under the GNU Affero General Public License, version 3
(AGPL-3.0-only).

- Source: <https://git.deuxfleurs.fr/Deuxfleurs/garage>
- GitHub mirror: <https://github.com/deuxfleurs-org/garage/tree/main-v2>
- License text: <https://github.com/deuxfleurs-org/garage/blob/main-v2/LICENSE>

If a built Garage image or binary is redistributed, its license and
corresponding-source requirements apply independently of Kurobako's own
license notice.
