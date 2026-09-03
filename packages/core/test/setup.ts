/**
 * Keep the suite hermetic.
 *
 * Several tests assert how a declared `~/.claude` path resolves. That
 * resolution deliberately follows CLAUDE_CONFIG_DIR — the variable the Claude
 * CLI itself honours — so a developer who separates accounts with it would see
 * those tests fail on their machine and pass in CI. The account axis has its
 * own coverage in claude-home.test.ts, which passes the value in explicitly;
 * nothing should read it from the ambient shell.
 */
delete process.env.CLAUDE_CONFIG_DIR;
