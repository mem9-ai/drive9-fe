#!/bin/sh
set -e

# drive9 installer
# Usage: curl -fsSL https://drive9.ai/install.sh | sh
#
# The release binary is only installed after its SHA-256 matches the manifest
# published at ${BASE_URL}/checksums.txt, and the destination is
# restricted to the allowlisted directories below.

BASE_URL="https://releases.drive9.ai/latest"
API_URL="https://api.drive9.ai"
DEFAULT_INSTALL_DIR="/usr/local/bin"
# Root-owned directories the installer may target. Elevated installs are limited
# to the literal /usr/local/bin and /opt/drive9 paths matched in
# ensure_install_dir/install_binary, so a DRIVE9_INSTALL_DIR value can never pick
# the target of a `sudo` command.
INSTALL_DIR=""
BIN_NAME="drive9"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { printf "  ${DIM}%s${RESET}\n" "$1"; }
success() { printf "  ${GREEN}%s${RESET}\n" "$1"; }
warn()    { printf "  ${YELLOW}%s${RESET}\n" "$1"; }
error()   { printf "  ${RED}error:${RESET} %b\n" "$1" >&2; exit 1; }

detect_os() {
  case "$(uname -s)" in
    Linux*)   echo "linux" ;;
    Darwin*)  echo "darwin" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) error "Unsupported OS: $(uname -s)" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)   echo "amd64" ;;
    aarch64|arm64)   echo "arm64" ;;
    *) error "Unsupported architecture: $(uname -m)" ;;
  esac
}

download() {
  if command -v curl > /dev/null 2>&1; then
    if [ -t 2 ]; then
      curl -fSL --progress-bar -o "$2" "$1"
    else
      curl -fsSL -o "$2" "$1"
    fi
  elif command -v wget > /dev/null 2>&1; then
    if [ -t 2 ]; then
      wget --show-progress -q -O "$2" "$1" 2>&1
    else
      wget -q -O "$2" "$1"
    fi
  else
    error "Neither curl nor wget found."
  fi
}

download_quiet() {
  if command -v curl > /dev/null 2>&1; then
    curl -fsSL -o "$2" "$1"
  elif command -v wget > /dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    error "Neither curl nor wget found."
  fi
}

fetch_version() {
  LATEST_VERSION=""
  VERSION_URL="${BASE_URL}/version"
  if command -v curl > /dev/null 2>&1; then
    LATEST_VERSION=$(curl -fsSL "$VERSION_URL" 2>/dev/null | tr -d '[:space:]') || true
  elif command -v wget > /dev/null 2>&1; then
    LATEST_VERSION=$(wget -q -O - "$VERSION_URL" 2>/dev/null | tr -d '[:space:]') || true
  fi
}

sha256_file() {
  _file="$1"
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$_file" | awk '{print $1}'
  elif command -v shasum > /dev/null 2>&1; then
    shasum -a 256 "$_file" | awk '{print $1}'
  elif command -v openssl > /dev/null 2>&1; then
    openssl dgst -sha256 "$_file" | sed 's/.*[ =] *//'
  else
    error "No SHA-256 tool found (need sha256sum, shasum, or openssl); refusing to install an unverified binary."
  fi
}

fetch_checksums() {
  CHECKSUMS_FILE="${TMP_DIR}/checksums.txt"
  if ! download_quiet "${BASE_URL}/checksums.txt" "$CHECKSUMS_FILE"; then
    error "Unable to download ${BASE_URL}/checksums.txt; refusing to install an unverified binary."
  fi
}

verify_checksum() {
  _file="$1"
  _name="$2"
  _expected=$(awk -v name="$_name" '
    {
      artifact = $2
      sub(/^\*/, "", artifact)
      sub(/^\.\//, "", artifact)
      if (artifact == name) { print tolower($1); exit }
    }' "$CHECKSUMS_FILE")
  if [ -z "$_expected" ]; then
    error "No SHA-256 entry for ${_name} in ${BASE_URL}/checksums.txt; refusing to install."
  fi

  _actual=$(sha256_file "$_file" | tr 'A-F' 'a-f')
  if [ "$_actual" != "$_expected" ]; then
    error "Checksum mismatch for ${_name}.\n  expected: ${_expected}\n  actual:   ${_actual}\n  The download was corrupted or tampered with; nothing was installed."
  fi
  info "Verified SHA-256 of ${_name}"
}

HOME_SUBDIRS=".local/bin bin .cargo/bin .drive9/bin"

is_system_install_dir() {
  case "$1" in
    /usr/local/bin|/opt/drive9) return 0 ;;
    *) return 1 ;;
  esac
}

# physical_home prints the directory $HOME really points at, so a home directory
# that is itself a symlink (or sits below one) is handled consistently. A $HOME
# that does not exist yet resolves through its deepest existing parent.
physical_home() {
  [ -n "${HOME:-}" ] || return 1
  canonicalize_dir "$HOME"
}

strip_trailing_slashes() {
  _path="$1"
  while [ "$_path" != "/" ] && [ "${_path%/}" != "$_path" ]; do
    _path="${_path%/}"
  done
  printf '%s\n' "$_path"
}

# canonicalize_dir resolves the deepest existing ancestor of a path and appends
# the components that do not exist yet, so a candidate and the trusted root are
# always compared in the same physical namespace. That matters for a fresh
# install under a symlinked $HOME, where neither the leaf nor its parent exists.
canonicalize_dir() {
  _target=$(strip_trailing_slashes "$1")
  _suffix=""
  _probe="$_target"
  while [ ! -d "$_probe" ]; do
    _parent=$(dirname "$_probe")
    if [ "$_parent" = "$_probe" ]; then
      printf '%s\n' "$_target"
      return 0
    fi
    _suffix="/$(basename "$_probe")${_suffix}"
    _probe="$_parent"
  done

  _physical=$(cd -P "$_probe" && pwd -P) || _physical="$_probe"
  case "$_suffix" in
    "") printf '%s\n' "$_physical" ;;
    *) printf '%s%s\n' "${_physical%/}" "$_suffix" ;;
  esac
}

# is_user_managed_dir matches the allowlisted spellings, both relative to $HOME
# and relative to the directory $HOME physically points at.
is_user_managed_dir() {
  [ -n "${HOME:-}" ] || return 1
  _home_root=$(physical_home) || return 1
  for _subdir in $HOME_SUBDIRS; do
    if [ "$1" = "${HOME}/${_subdir}" ] || [ "$1" = "${_home_root}/${_subdir}" ]; then
      return 0
    fi
  done
  return 1
}

is_allowed_install_dir() {
  is_user_managed_dir "$1" || is_system_install_dir "$1"
}

# is_install_dir_safe is the destination policy: the directory must be spelled
# as an allowlisted location, and a user-managed location must resolve to a
# physical path inside the user's own home tree. That keeps a legitimately
# symlinked home (or a symlinked $HOME/.local/bin pointing inside $HOME)
# working, while a link at or below the allowlisted leaf that escapes $HOME is
# refused. System directories are root-owned and matched literally.
is_install_dir_safe() {
  _dir=$(strip_trailing_slashes "$1")
  case "$_dir" in
    /*) ;;
    *) return 1 ;;
  esac
  is_system_install_dir "$_dir" && return 0
  is_user_managed_dir "$_dir" || return 1

  _home_root=$(physical_home) || return 1
  _physical=$(canonicalize_dir "$_dir")
  case "$_physical" in
    "${_home_root}"/*) return 0 ;;
  esac
  return 1
}

allowed_install_dirs() {
  _dirs="/usr/local/bin, /opt/drive9"
  if [ -n "${HOME:-}" ]; then
    _dirs="${HOME}/.local/bin, ${HOME}/bin, ${HOME}/.cargo/bin, ${HOME}/.drive9/bin, ${_dirs}"
    _home_root=$(physical_home) || _home_root=""
    if [ -n "${_home_root}" ] && [ "${_home_root}" != "${HOME}" ]; then
      _dirs="${_home_root}/.local/bin, ${_home_root}/bin, ${_home_root}/.cargo/bin, ${_home_root}/.drive9/bin, ${_dirs}"
    fi
  fi
  printf '%s\n' "$_dirs"
}

validate_requested_install_dir() {
  _requested=$(strip_trailing_slashes "$1")
  # Only control characters are refused outright: they cannot appear in a real
  # install path and would corrupt the reported lines.
  if [ "$(printf '%s' "$_requested" | tr -d '[:cntrl:]')" != "$_requested" ]; then
    error "DRIVE9_INSTALL_DIR contains control characters."
  fi
  case "$_requested" in
    /*) ;;
    *) error "DRIVE9_INSTALL_DIR must be an absolute path (got '${_requested}')." ;;
  esac
  if ! is_install_dir_safe "$_requested"; then
    _resolved=$(canonicalize_dir "$_requested")
    error "DRIVE9_INSTALL_DIR='${_requested}' is not a safe install directory.\n  Resolved: ${_resolved}\n  Allowed:  $(allowed_install_dirs)\n  A user directory must resolve inside ${HOME} (or wherever it physically lives); a symlink that leads elsewhere is refused."
  fi
  printf '%s\n' "$_requested"
}

# Every selected destination, including the literal default, goes through the
# same policy before anything is probed or written.
select_default_install_dir() {
  if ! is_install_dir_safe "$DEFAULT_INSTALL_DIR"; then
    _resolved=$(canonicalize_dir "$DEFAULT_INSTALL_DIR")
    error "The default install directory ${DEFAULT_INSTALL_DIR} is not usable.\n  Resolved: ${_resolved}\n  Allowed:  $(allowed_install_dirs)\n  Set DRIVE9_INSTALL_DIR to an allowlisted directory and rerun the installer."
  fi
  INSTALL_DIR="$DEFAULT_INSTALL_DIR"
}

resolve_install_dir() {
  if [ -n "${DRIVE9_INSTALL_DIR:-}" ]; then
    INSTALL_DIR=$(validate_requested_install_dir "$DRIVE9_INSTALL_DIR")
    info "Install dir: ${INSTALL_DIR} (from DRIVE9_INSTALL_DIR)"
    return
  fi

  EXISTING=$(command -v drive9 2>/dev/null || true)
  if [ -n "$EXISTING" ] && [ -x "$EXISTING" ]; then
    EXISTING_DIR=$(dirname "$EXISTING")
    if is_allowed_install_dir "$EXISTING_DIR"; then
      # The active binary can be reached through an allowlisted spelling that is
      # a symlink; it must pass the same physical check as an explicit request
      # before the old-version probe runs or anything is written.
      if ! is_install_dir_safe "$EXISTING_DIR"; then
        error "The active drive9 resolves to ${EXISTING}, which is an allowlisted location that points outside your home directory.\n  Resolved: $(canonicalize_dir "$EXISTING_DIR")\n  Allowed:  $(allowed_install_dirs)\n  Remove that copy (or the symlink) and rerun the installer."
      fi
      INSTALL_DIR="$EXISTING_DIR"
      info "Upgrading active drive9 in ${INSTALL_DIR}"
      return
    fi

    select_default_install_dir
    warn "drive9 currently resolves to ${EXISTING}"
    warn "Installing to ${INSTALL_DIR}; set DRIVE9_INSTALL_DIR=${EXISTING_DIR} to replace the active binary"
    return
  fi

  select_default_install_dir
  info "Install dir: ${INSTALL_DIR}"
}

ensure_install_dir() {
  if [ -d "$INSTALL_DIR" ]; then
    return 0
  fi

  case "$INSTALL_DIR" in
    /usr/local/bin|/opt/drive9)
      info "Creating ${INSTALL_DIR} (requires sudo)..."
      sudo mkdir -p -- "$INSTALL_DIR"
      ;;
    *)
      if ! mkdir -p -- "$INSTALL_DIR" 2>/dev/null; then
        error "Cannot create ${INSTALL_DIR}."
      fi
      ;;
  esac
}

install_binary() {
  _src="$1"
  _dst="${INSTALL_DIR}/${BIN_NAME}"

  if [ -w "$INSTALL_DIR" ]; then
    mv -- "$_src" "$_dst"
    return
  fi

  info "Installing to ${INSTALL_DIR} (requires sudo)..."
  case "$INSTALL_DIR" in
    /usr/local/bin|/opt/drive9) sudo mv -- "$_src" "$_dst" ;;
    *) error "Cannot write to ${INSTALL_DIR}; rerun with sufficient permissions." ;;
  esac
}

report_path_status() {
  INSTALLED="${INSTALL_DIR}/${BIN_NAME}"
  ACTIVE=$(command -v "${BIN_NAME%.exe}" 2>/dev/null || true)

  if [ -z "$ACTIVE" ]; then
    warn "drive9 is installed at ${INSTALLED}, but ${INSTALL_DIR} is not on your PATH"
    warn "Run ${INSTALLED} directly or add ${INSTALL_DIR} to PATH"
    return
  fi

  if [ "$ACTIVE" != "$INSTALLED" ]; then
    warn "PATH shadowing detected: drive9 resolves to ${ACTIVE}"
    warn "Installed binary: ${INSTALLED}"
    warn "Re-run with DRIVE9_INSTALL_DIR='$(dirname "$ACTIVE")' to replace the active binary"
  fi
}

bootstrap_config() {
  if [ -z "${HOME:-}" ]; then
    return
  fi
  CONFIG_DIR="${HOME}/.drive9"
  CONFIG_FILE="${CONFIG_DIR}/config"
  mkdir -p "${CONFIG_DIR}" 2>/dev/null || true
  if [ ! -f "${CONFIG_FILE}" ]; then
    cat > "${CONFIG_FILE}" <<CONF
{
  "server": "${API_URL}",
  "contexts": {}
}
CONF
    chmod 600 "${CONFIG_FILE}"
  fi
}

main() {
  printf "\n"
  printf "  ${BOLD}drive9${RESET} installer\n"
  printf "  ${DIM}────────────────────────────${RESET}\n"
  printf "\n"

  OS=$(detect_os)
  ARCH=$(detect_arch)
  info "Platform: ${OS}/${ARCH}"

  # Validate the destination before contacting the release origin.
  resolve_install_dir

  LATEST_VERSION=""
  fetch_version
  if [ -n "$LATEST_VERSION" ]; then
    info "Latest version: v${LATEST_VERSION}"
  fi

  ARTIFACT="drive9-${OS}-${ARCH}"
  if [ "$OS" = "windows" ]; then
    ARTIFACT="${ARTIFACT}.exe"
    BIN_NAME="drive9.exe"
  fi

  OLD_VERSION=""
  if [ -x "${INSTALL_DIR}/${BIN_NAME}" ]; then
    OLD_VERSION=$("${INSTALL_DIR}/${BIN_NAME}" --version 2>/dev/null | sed 's/^drive9[[:space:]]*//' | tr -d '[:space:]') || true
  fi

  TMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TMP_DIR"' EXIT

  # Integrity check first: nothing is written or installed before the manifest
  # lists the artifact and the download matches it.
  fetch_checksums

  # Download drive9 (FUSE support is built-in, no separate binary needed)
  if [ -n "$LATEST_VERSION" ]; then
    info "Downloading drive9 v${LATEST_VERSION}..."
  else
    info "Downloading drive9..."
  fi
  if ! download "${BASE_URL}/${ARTIFACT}" "$TMP_DIR/${BIN_NAME}"; then
    error "No pre-built binary available for ${OS}/${ARCH}.\n  Available: linux/amd64, linux/arm64, darwin/arm64, darwin/amd64\n  Visit https://drive9.ai for more info."
  fi
  chmod +x "$TMP_DIR/${BIN_NAME}"
  verify_checksum "$TMP_DIR/${BIN_NAME}" "$ARTIFACT"

  ensure_install_dir
  install_binary "$TMP_DIR/${BIN_NAME}"

  printf "\n"
  NEW_VERSION=$("${INSTALL_DIR}/${BIN_NAME}" --version 2>/dev/null | sed 's/^drive9[[:space:]]*//' | tr -d '[:space:]') || true
  if [ -n "$OLD_VERSION" ] && [ -n "$NEW_VERSION" ] && [ "$OLD_VERSION" != "$NEW_VERSION" ]; then
    success "drive9 upgraded successfully! (v${OLD_VERSION} -> v${NEW_VERSION})"
  elif [ -n "$NEW_VERSION" ]; then
    success "drive9 installed successfully! (v${NEW_VERSION})"
  else
    success "drive9 installed successfully!"
  fi
  bootstrap_config
  report_path_status
  printf "\n"
  printf "  Get started:\n"
  printf "\n"
  printf "    ${BOLD}1.${RESET} Create an owner context\n"
  printf "       ${DIM}\$${RESET} drive9 create\n"
  printf "       ${DIM}\$${RESET} drive9 ctx show\n"
  printf "\n"
  printf "    ${BOLD}2.${RESET} Try filesystem commands\n"
  printf "       ${DIM}\$${RESET} drive9 fs ls :/\n"
  printf "       ${DIM}\$${RESET} drive9 fs cp ./file.txt :/data/file.txt\n"
  printf "       ${DIM}\$${RESET} drive9 fs grep \"search term\" /\n"
  printf "       ${DIM}\$${RESET} drive9 fs find /data -name \"*.txt\"\n"
  printf "\n"
  printf "    ${BOLD}3.${RESET} Mount locally\n"
  printf "       ${DIM}\$${RESET} mkdir -p ~/drive9\n"
  printf "       ${DIM}\$${RESET} drive9 mount ~/drive9\n"
  printf "       ${DIM}\$${RESET} drive9 umount ~/drive9\n"
  printf "\n"
  printf "    ${BOLD}4.${RESET} Fork a workspace\n"
  printf "       ${DIM}\$${RESET} drive9 ctx fork my-branch       ${DIM}# create a copy-on-write fork${RESET}\n"
  printf "       ${DIM}\$${RESET} drive9 ctx ls                   ${DIM}# list all contexts${RESET}\n"
  printf "       ${DIM}\$${RESET} drive9 ctx use my-branch        ${DIM}# switch to the fork${RESET}\n"
  printf "\n"
  printf "  If mount fails: ${DIM}drive9 doctor fuse${RESET}\n"
  printf "  Help: ${DIM}drive9 --help${RESET}  ${DIM}drive9 fs --help${RESET}  ${DIM}drive9 ctx --help${RESET}\n"
  printf "\n"
  printf "  Docs: ${DIM}https://drive9.ai${RESET}\n"
  printf "\n"
}

main
