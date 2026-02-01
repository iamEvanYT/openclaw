# Browser Snapshot Expiration

Browser snapshots are large DOM tree outputs (up to 80KB each) that can accumulate in the context window during web browsing sessions. This feature automatically expires old snapshots to save tokens, reduce costs, and improve agent efficiency.

## How It Works

1. **When a browser snapshot is taken**: The tool result is detected by looking for characteristic patterns (element refs like `[e1]`, `url:`, `title:`, semantic HTML tags)

2. **Counter starts at 0**: Each snapshot gets its own counter that starts at 0 when registered

3. **Counter increments on**:
   - Each new tool call result
   - Each new user message

4. **When counter reaches threshold (default: 3)**: The snapshot content is replaced with a static placeholder

5. **When a new snapshot is taken**: All existing snapshots are immediately expired, regardless of their counter value

6. **Persistence**: Expired snapshot IDs are persisted to the session, so they remain expired across restarts

## Default Behavior

Browser snapshot expiration is **enabled by default** with these settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Whether the feature is active |
| `toolCalls` | `3` | Number of tool calls/user messages before expiration |

## Configuration

Configure in your `openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "contextPruning": {
        "browserSnapshot": {
          "expiry": {
            "enabled": true,
            "toolCalls": 3
          }
        }
      }
    }
  }
}
```

### Disable the Feature

```json
{
  "agents": {
    "defaults": {
      "contextPruning": {
        "browserSnapshot": {
          "expiry": {
            "enabled": false
          }
        }
      }
    }
  }
}
```

### Change the Expiration Threshold

```json
{
  "agents": {
    "defaults": {
      "contextPruning": {
        "browserSnapshot": {
          "expiry": {
            "toolCalls": 5
          }
        }
      }
    }
  }
}
```

## Example Timeline

```
Turn 1: User asks to check a webpage
Turn 2: Agent takes browser snapshot A (counter: 0)
Turn 3: Agent clicks a button (counter: 1)
Turn 4: Agent reads some text (counter: 2)
Turn 5: Agent fills a form (counter: 3) -> Snapshot A EXPIRES
```

Or with a new snapshot:

```
Turn 1: User asks to check a webpage
Turn 2: Agent takes browser snapshot A (counter: 0)
Turn 3: Agent clicks a link
Turn 4: Agent takes browser snapshot B -> Snapshot A EXPIRES immediately
```

## Technical Details

### Expired Placeholder

When a snapshot expires, its content is replaced with:

```
[Browser snapshot expired - content cleared]
```

This static placeholder is intentionally constant to preserve prompt caching efficiency.

### Independence from Context Pruning

Browser snapshot expiration works **independently** of the main context pruning feature. It runs even when `contextPruning.mode` is set to `"off"`.

### Persistence

Expired snapshot IDs are stored in the session using custom entries with type `openclaw.browser-snapshot-expiry`. This ensures:

- Expired snapshots stay expired across session restarts
- The agent won't attempt to re-track already expired snapshots

### Detection Heuristics

A tool result is detected as a browser snapshot if it contains:

1. Element reference patterns like `[e1]`, `[e2]`, etc.
2. A `url:` line
3. A `title:` line  
4. Semantic HTML tags like `<main>`, `<nav>`, `<section>`, `<article>`, `<header>`, `<footer>`, `<aside>`

JSON responses from the browser tool (like status or tab listings) are not considered snapshots.

## Benefits

- **Token savings**: Large DOM trees are cleared from context after a few turns
- **Cost reduction**: Fewer tokens = lower API costs
- **Better agent performance**: Smaller context = faster responses and less confusion
- **Prompt caching friendly**: Static placeholder preserves cache efficiency
- **Automatic**: No user intervention needed

## Token Counting and `/status`

The `/status` command shows the context token count from the **last model API call**. Since browser snapshot expiration happens before the API call (on the "context" event), the token count reflects the post-expiration context size.

**Important notes:**
- Token counts are cached from the last run, not calculated on-demand
- If snapshots were just taken and no subsequent API call has been made, the displayed tokens may not yet reflect future savings
- After the next API call following an expiration, `/status` will show the reduced token count
