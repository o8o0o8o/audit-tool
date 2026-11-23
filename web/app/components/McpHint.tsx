/**
 * A one-line pointer to the MCP setup, shown on the internal audit pages: what a person does here
 * they can also ask their AI assistant to do.
 */
export function McpHint({ text = 'You can also do this from your AI assistant.' }: { text?: string }) {
  return (
    <p className="muted mcp-hint" data-testid="mcp-hint">
      {text}{' '}
      <a className="link-accent" href="/internal/mcp">
        Set up MCP
      </a>
    </p>
  );
}
