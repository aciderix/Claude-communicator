#!/data/data/com.termux/files/usr/bin/sh
# Démarrage automatique du relais claude-comm au boot du téléphone.
#
# Installation (une seule fois) :
#   1. Installer l'app Termux:Boot (F-Droid), l'ouvrir une fois.
#   2. mkdir -p ~/.termux/boot
#      cp ~/claude-communicator/termux/boot-claude-comm.sh ~/.termux/boot/
#      chmod +x ~/.termux/boot/boot-claude-comm.sh
# Ensuite : le relais (et son tunnel) démarre tout seul à chaque
# redémarrage du téléphone. Journal : ~/.claude-comm/up.log
termux-wake-lock
cd "$HOME/claude-communicator" || exit 1
git pull --ff-only >/dev/null 2>&1
mkdir -p "$HOME/.claude-comm"
nohup node up.js --tunnel localtunnel >> "$HOME/.claude-comm/up.log" 2>&1 &
