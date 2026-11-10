# The install GIF in the README. Regenerate from the repository root:
#
#   docs/demo/setup.sh && vhs docs/demo/install.tape
#
# It runs the real public installer and the real wizard, in an empty home at /tmp/you.
# Hide covers only the shell setup and clearing the screen between the two commands.
# Typing is scripted; output is not edited. Bun uses your existing package cache, because a
# cache under /tmp makes it print a slow-filesystem warning no normal install would show.

Output docs/images/install.gif

Set Shell "bash"
Set FontSize 16
Set Width 1120
Set Height 760
Set Padding 24
Set TypingSpeed 25ms
Set Framerate 15
Set PlaybackSpeed 1.0
Set Theme "Catppuccin Mocha"

Hide
Type `source docs/demo/env.sh; cd /tmp/you; clear`
Enter
Sleep 1s
Show

Type "curl -fsSL https://raw.githubusercontent.com/mousedown/portia/main/scripts/install.sh | bash"
Sleep 400ms
Enter
Wait+Screen@120s /Remove with --uninstall/
Sleep 3s

# VHS's Screen wait only sees the first screenful, so start the wizard on a clean one.
Hide
Type "clear"
Enter
Sleep 300ms
Show

Type "cd your-repo && portia init"
Sleep 400ms
Enter
Wait+Screen@30s /Where do your tickets live/
Sleep 2.5s
Enter
Sleep 4s
Enter
Sleep 4s
