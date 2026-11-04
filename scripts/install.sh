#!/usr/bin/env bash
# Install Portia: the `portia` CLI on your PATH and the Portia skills in Claude Code.
#
#   curl -fsSL https://raw.githubusercontent.com/mousedown/portia/main/scripts/install.sh | bash
#
# or, from a checkout:  ./scripts/install.sh
#
# It installs Bun if you do not have it, and the latest release of Portia (main until the
# first release). Everything goes under your home directory; it never uses sudo.
#
# Options:
#   --ref <ref>  install this tag, branch or commit instead of the latest release
#   --design     also install headless Chromium for design checks
#   --uninstall  remove the CLI link and the skill links (keeps ~/.portia)
#
# Environment:
#   PORTIA_REF        the same as --ref
#   PORTIA_REPO_URL   where to clone from (default https://github.com/mousedown/portia.git)
#   PORTIA_SRC        where the source is cloned (default ~/.portia/src)
#   PORTIA_BIN_DIR    where the `portia` link goes (default $BUN_INSTALL/bin or ~/.bun/bin)
#   CLAUDE_SKILLS_DIR where the skill links go (default $CLAUDE_CONFIG_DIR/skills, else ~/.claude/skills)
set -euo pipefail

# Everything runs from main, called on the last line, so a download cut off part-way
# through `curl | bash` runs nothing at all.
main() {
	local repo_url="${PORTIA_REPO_URL:-https://github.com/mousedown/portia.git}"
	local home="${PORTIA_HOME:-$HOME/.portia}"
	local src="${PORTIA_SRC:-$home/src}"
	local bin_dir="${PORTIA_BIN_DIR:-${BUN_INSTALL:-$HOME/.bun}/bin}"
	# Claude Code reads skills from $CLAUDE_CONFIG_DIR when it is set, not ~/.claude.
	local skills_dir="${CLAUDE_SKILLS_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills}"
	local ref="${PORTIA_REF:-}" design=0 uninstall=0

	while [ $# -gt 0 ]; do
		case "$1" in
		--ref)
			[ $# -ge 2 ] || die "--ref needs a tag, branch or commit."
			ref="$2"
			shift
			;;
		--design) design=1 ;;
		--uninstall) uninstall=1 ;;
		-h | --help)
			echo "Usage: install.sh [--ref <ref>] [--design] [--uninstall]"
			return 0
			;;
		*) die "Unknown option: $1" ;;
		esac
		shift
	done

	if [ "$uninstall" = 1 ]; then
		remove_link "$bin_dir/portia"
		for skill in portia portia-setup; do
			remove_link "$skills_dir/$skill"
		done
		say "Uninstalled. Source, profiles and run state are left in $home."
		return 0
	fi

	case "$(uname -s)" in
	Darwin | Linux) ;;
	*) die "Portia runs on macOS and Linux. On Windows, install inside WSL." ;;
	esac

	# 1. What the install itself needs
	has git || die "git is required: https://git-scm.com/downloads"
	local shell_path="$PATH"
	ensure_bun

	# 2. Source: this checkout when run from one, otherwise clone or update
	local here="" script="${BASH_SOURCE[0]:-}" checkout=0
	[ -n "$script" ] && [ -f "$script" ] && here="$(cd "$(dirname "$script")" && pwd)"
	if [ -z "$ref" ] && [ -n "$here" ] && [ -f "$here/../skills/portia/SKILL.md" ] && [ -f "$here/../src/cli/main.ts" ]; then
		src="$(cd "$here/.." && pwd)"
		checkout=1
		say "Using the checkout at $src"
	else
		fetch_source "$repo_url" "$src" "$ref"
	fi

	# 3. Dependencies. A contributor's checkout keeps its dev tools; an install needs none,
	# and no dependency's install script runs.
	say "Installing dependencies"
	if [ "$checkout" = 1 ]; then
		(cd "$src" && bun install --frozen-lockfile >/dev/null)
	else
		(cd "$src" && bun install --frozen-lockfile --production --ignore-scripts >/dev/null)
	fi

	# 4. The CLI
	mkdir -p "$bin_dir"
	[ ! -e "$bin_dir/portia" ] || [ -L "$bin_dir/portia" ] ||
		die "$bin_dir/portia already exists and is not a link. Move it, then run this again."
	ln -sfn "$src/src/cli/main.ts" "$bin_dir/portia"
	say "Linked $bin_dir/portia"

	# 5. The skills
	mkdir -p "$skills_dir"
	local dir skill
	for dir in "$src"/skills/*/; do
		skill="$(basename "$dir")"
		if [ -e "$skills_dir/$skill" ] && [ ! -L "$skills_dir/$skill" ]; then
			warn "$skills_dir/$skill already exists and is not a link; left it alone."
		else
			ln -sfn "$src/skills/$skill" "$skills_dir/$skill"
			say "Linked the $skill skill into $skills_dir"
		fi
	done

	# 6. Somewhere for private profiles
	mkdir -p "$home/profiles"

	# 7. Optional: Chromium for design checks
	if [ "$design" = 1 ]; then
		say "Installing Chromium for design checks"
		(cd "$src" && bunx playwright install chromium)
	fi

	"$bin_dir/portia" version >/dev/null || die "The portia CLI did not start."

	echo
	say "Installed $("$bin_dir/portia" version)."
	report_next_steps "$bin_dir" "$shell_path"
}

ensure_bun() {
	local bun_home="${BUN_INSTALL:-$HOME/.bun}"
	has bun && return 0
	if [ ! -x "$bun_home/bin/bun" ]; then
		has curl || die "Bun is required, and installing it needs curl: https://bun.sh"
		has unzip || die "Bun's installer needs unzip. Install it, then run this again."
		say "Installing Bun (https://bun.sh)"
		curl -fsSL https://bun.sh/install | bash >/dev/null || die "Could not install Bun: see https://bun.sh"
	fi
	export PATH="$bun_home/bin:$PATH"
	has bun || die "Bun was installed but did not start: see https://bun.sh"
}

fetch_source() {
	local url="$1" src="$2" ref="$3"
	if [ -d "$src/.git" ]; then
		say "Updating $src"
		git -C "$src" fetch --quiet --tags --force origin
	else
		say "Downloading Portia into $src"
		mkdir -p "$(dirname "$src")"
		git clone --quiet "$url" "$src"
	fi
	if [ -z "$ref" ]; then
		ref="$(git -C "$src" tag --list 'v[0-9]*' --sort=-version:refname | grep -v -- - | head -n 1 || true)"
		[ -n "$ref" ] || ref=main
	fi
	if git -C "$src" show-ref --verify --quiet "refs/remotes/origin/$ref"; then
		git -C "$src" checkout --quiet -B "$ref" "origin/$ref" ||
			die "Could not update $src to $ref. Commit or discard the changes there, then run this again."
	else
		git -C "$src" checkout --quiet --detach "$ref" ||
			die "Could not check out $ref in $src. Check the name, and commit or discard any changes there."
	fi
}

# The install is done; these are what a first run needs, each with the one command that fixes it.
report_next_steps() {
	local bin_dir="$1" shell_path="$2" missing=0
	# Your shell's PATH, not the one this script extended for itself.
	case ":$shell_path:" in
	*":$bin_dir:"*) ;;
	*)
		missing=1
		warn "$bin_dir is not on your PATH yet. Run this now, and add it to your shell profile if a new terminal does not have it:"
		warn "  export PATH=\"$bin_dir:\$PATH\""
		;;
	esac
	if ! has gh; then
		missing=1
		warn "Portia opens PRs with the GitHub CLI, which is not installed: https://cli.github.com"
	elif ! gh auth status >/dev/null 2>&1; then
		missing=1
		warn "The GitHub CLI is not logged in. Run: gh auth login"
	fi
	if ! has claude; then
		missing=1
		warn "Portia runs in Claude Code, which is not installed: https://docs.claude.com/claude-code"
	fi
	[ "$missing" = 0 ] || echo
	cat <<NEXT
Next, in your repository:

  portia init          (or /portia-setup in Claude Code)

Then run an epic in Claude Code:

  /portia <EPIC>

Update by running this again. Remove with --uninstall.
NEXT
}

remove_link() {
	if [ -L "$1" ]; then
		rm "$1"
		say "Removed $1"
	fi
}

say() {
	if [ -t 1 ]; then printf '\033[1m%s\033[0m\n' "$*"; else printf '%s\n' "$*"; fi
}
warn() {
	if [ -t 2 ]; then printf '\033[33m! %s\033[0m\n' "$*" >&2; else printf '! %s\n' "$*" >&2; fi
}
die() {
	if [ -t 2 ]; then printf '\033[31m✗ %s\033[0m\n' "$*" >&2; else printf 'x %s\n' "$*" >&2; fi
	exit 1
}
has() { command -v "$1" >/dev/null 2>&1; }

main "$@"
