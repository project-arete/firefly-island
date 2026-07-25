#!/bin/bash
# Firefly Island — island spirit (beacon host). Ctrl+C to put it to sleep.
cd "$(dirname "$0")/spirit"
[ -d node_modules ] || npm install
node island-spirit.js
