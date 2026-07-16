/**
 * Binding between the preview Noam SAW and the payload that EXECUTES.
 *
 * A pending action is minted only inside the agent loop, and carries an HMAC
 * over (toolName, schema-canonical input). The approval endpoint refuses any
 * payload whose signature does not verify — so a client-side mutation of the
 * input between render and click, or a direct call that never went through a
 * preview, cannot execute. Canonical form = JSON of the zod-PARSED input
 * (zod emits keys in schema order, so serialization is deterministic).
 *
 * The secret is per-process by default (AGENT_APPROVAL_SECRET for
 * multi-instance deploys): a server restart voids open cards — they fail
 * with a clear Hebrew error and Noam simply asks again.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const secret = process.env.AGENT_APPROVAL_SECRET ?? randomBytes(32).toString("hex");

function digest(toolName: string, canonicalInput: unknown): Buffer {
  return createHmac("sha256", secret)
    .update(`${toolName}\n${JSON.stringify(canonicalInput)}`)
    .digest();
}

/** Called at preview time, over the schema-parsed input. */
export function signPendingAction(toolName: string, canonicalInput: unknown): string {
  return digest(toolName, canonicalInput).toString("base64url");
}

/** Called at approval time, over the RE-PARSED input. Constant-time compare. */
export function verifyPendingAction(
  toolName: string,
  canonicalInput: unknown,
  signature: string,
): boolean {
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "base64url");
  } catch {
    return false;
  }
  const expected = digest(toolName, canonicalInput);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
