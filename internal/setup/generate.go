package setup

// Sync embedded plugin copies from the source of truth (plugin/ directory).
// Claude Code is installed via marketplace, but OpenCode/Pi adapters are embedded.
// Run: go generate ./internal/setup/
//go:generate sh -c "rm -rf plugins/opencode plugins/pi && mkdir -p plugins/opencode plugins/pi && cp ../../plugin/opencode/engram.ts plugins/opencode/ && cp ../../plugin/pi/engram.ts plugins/pi/"
