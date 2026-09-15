/**
 * Turn-scoped reply suppression guard.
 *
 * Problem: when the agent replies via the `qq_send_message` tool (direct HTTP
 * send), the normal end-of-turn reply delivery fires afterwards and sends the
 * agent's closing text to the same chat again — the user receives duplicates.
 *
 * Approach: qq_send_message marks the target chat when it sends. The monitor's
 * deliver callback checks the marker for the incoming chat and skips delivery
 * when a tool already replied there this turn.
 *
 * Marker lifecycle (keyed "group:<id>" / "private:<id>"):
 *  - set   when qq_send_message sends successfully
 *  - clear when a NEW inbound message arrives for that chat (processMessage
 *          start) — i.e. markers live exactly one turn
 *  - expire after EXPIRY_MS as a safety net for missed clears
 *
 * Trade-off (accepted): if one turn's tool send targets a DIFFERENT user's
 * chat while that user's own turn is in flight, that user's reply could be
 * wrongly suppressed. Rare in practice (requires concurrent cross-chat
 * sends); markers are one-shot per turn and time-bounded.
 */

const EXPIRY_MS = 5 * 60 * 1000;

const sentChats = new Map<string, number>();

function chatKey(kind: "group" | "private", id: string | number): string {
  return `${kind}:${id}`;
}

/** Record that qq_send_message delivered to this chat during the current turn. */
export function markToolSent(kind: "group" | "private", id: string | number): void {
  // Opportunistic prune of stale entries.
  if (sentChats.size > 256) {
    const now = Date.now();
    for (const [key, at] of sentChats) {
      if (now - at > EXPIRY_MS) sentChats.delete(key);
    }
  }
  sentChats.set(chatKey(kind, id), Date.now());
}

/** Clear the marker for a chat — called when a new inbound turn begins. */
export function clearToolSent(kind: "group" | "private", id: string | number): void {
  sentChats.delete(chatKey(kind, id));
}

/** True when a tool sent to this chat recently (same turn window). */
export function wasToolSent(kind: "group" | "private", id: string | number): boolean {
  const at = sentChats.get(chatKey(kind, id));
  return typeof at === "number" && Date.now() - at <= EXPIRY_MS;
}
