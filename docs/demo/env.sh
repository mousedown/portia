# Sourced by docs/demo/install.tape. Points every install location at the throwaway home,
# so the real installer cannot touch your own Portia, Bun or Claude Code setup.
GH_TOKEN="$(gh auth token)" # so the installer's login check passes with HOME moved
export GH_TOKEN
export BUN_INSTALL_CACHE_DIR="$HOME/.bun/install/cache"
unset BUN_INSTALL PORTIA_HOME PORTIA_SRC PORTIA_BIN_DIR PORTIA_PROFILES_DIR \
	CLAUDE_CONFIG_DIR CLAUDE_SKILLS_DIR PORTIA_PROFILE JIRA_BASE_URL JIRA_EMAIL JIRA_API_TOKEN
export HOME=/tmp/you
export PATH="/tmp/you/.bun/bin:$PATH"
export PS1='$ '
