// tui/use-approvals.ts — the TUI's pause-and-ask interactions.
//
// While the agent loop runs it can pause on four kinds of human gate, each of
// which suspends the loop on an unresolved promise until the user answers:
//   • confirm   — the y/n/a box before a mutating tool runs (humanConfirm)
//   • checkpoint — the periodic "keep going?" runaway guard
//   • ask        — the ask_user tool's question box
//   • plan       — a finished plan awaiting accept/edit/reject
// Each is a {state, ref, resolver-ref} triple: the state drives the overlay, the
// ref mirrors it for the once-captured `useInput` closure, and the resolver-ref
// holds the promise's resolve fn. `requestGate` is the HUMAN confirm gate only —
// the AI permission check is now composed in front of it by `assembleSession`
// (`buildPermissionGate` + `composeGates`), so a deny from the AI check
// short-circuits before this gate is consulted. Pulled out of App so the
// component body stays small; this is the project's approved encapsulation
// boundary (a custom hook).

import { useRef, useState } from "react";
import type { AgentMode } from "../agent.ts";
import type { AskAnswer, AskQuestion } from "../assemble.ts";
import type { Config } from "../config.ts";
import { buildConfirmPreview, type ConfirmPreview } from "./confirm-helpers.ts";

export interface Approvals {
  // ── confirm (y/n/a) ──
  pendingConfirm: ConfirmPreview | null;
  pendingConfirmReason: string | null;
  pendingConfirmRef: React.MutableRefObject<ConfirmPreview | null>;
  resolveConfirm: (ok: boolean, always: boolean) => void;
  // ── checkpoint ──
  pendingCheckpoint: number | null;
  pendingCheckpointRef: React.MutableRefObject<number | null>;
  requestCheckpoint: (turn: number) => Promise<boolean>;
  resolveCheckpoint: (ok: boolean) => void;
  // ── ask_user ──
  pendingAsk: AskQuestion[] | null;
  askKey: number;
  pendingAskRef: React.MutableRefObject<AskQuestion[] | null>;
  requestAsk: (questions: AskQuestion[]) => Promise<AskAnswer[] | null>;
  resolveAsk: (answers: AskAnswer[] | null) => void;
  // ── plan review ──
  pendingPlan: string | null;
  pendingPlanRef: React.MutableRefObject<string | null>;
  showPlan: (text: string | null) => void;
  // ── the composed gate the agent loop calls before a mutating tool runs ──
  requestGate: (
    runMode: AgentMode,
    call: { id: string; name: string; input: unknown },
    aiFlag?: { reason: string },
  ) => Promise<{ allow: boolean; reason?: string }>;
  /** Decline every open gate (used by the cancel escalation so an abort can
   *  propagate instead of deadlocking on an unresolved promise). */
  declineAllPending: () => void;
}

export function useApprovals(opts: { config: Config }): Approvals {
  const { config } = opts;

  // ── confirm ──
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmPreview | null>(
    null,
  );
  const [pendingConfirmReason, setPendingConfirmReason] = useState<
    string | null
  >(null);
  const pendingConfirmRef = useRef<ConfirmPreview | null>(null);
  const confirmResolverRef = useRef<((ok: boolean) => void) | null>(null);
  const confirmAlwaysRef = useRef(false);

  // ── checkpoint ──
  const [pendingCheckpoint, setPendingCheckpoint] = useState<number | null>(
    null,
  );
  const pendingCheckpointRef = useRef<number | null>(null);
  const checkpointResolverRef = useRef<((ok: boolean) => void) | null>(null);

  // ── ask_user ──
  const [pendingAsk, setPendingAsk] = useState<AskQuestion[] | null>(null);
  const [askKey, setAskKey] = useState(0);
  const pendingAskRef = useRef<AskQuestion[] | null>(null);
  const askResolverRef = useRef<((answers: AskAnswer[] | null) => void) | null>(
    null,
  );

  // ── plan review ──
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  const pendingPlanRef = useRef<string | null>(null);
  const showPlan = (text: string | null) => {
    pendingPlanRef.current = text;
    setPendingPlan(text);
  };

  /** Render the y/n/a box (optionally with an AI reason) and await the choice. */
  function humanConfirm(
    call: { name: string; input: unknown },
    reason: string | null,
  ): Promise<boolean> {
    return buildConfirmPreview(call).then(
      (preview) =>
        new Promise<boolean>((resolve) => {
          confirmResolverRef.current = resolve;
          pendingConfirmRef.current = preview;
          setPendingConfirm(preview);
          setPendingConfirmReason(reason);
        }),
    );
  }

  /** Resolve a pending confirm with the user's choice and tear down the box. */
  function resolveConfirm(ok: boolean, always: boolean): void {
    const resolve = confirmResolverRef.current;
    if (!resolve) return;
    if (always) confirmAlwaysRef.current = true;
    confirmResolverRef.current = null;
    pendingConfirmRef.current = null;
    setPendingConfirm(null);
    setPendingConfirmReason(null);
    resolve(ok);
  }

  // ── the HUMAN approval gate the agent loop calls before a mutating tool runs ──
  // The AI permission check (permission.mode === "ai") is composed IN FRONT of
  // this gate by assembleSession (buildPermissionGate + composeGates). When the
  // AI check flags a call it does NOT hard-block: it ESCALATES here with an
  // `aiFlag` advisory, and we put the call to the human y/n/a box showing the
  // AI's reason — the human's verdict is final (they can still approve). An
  // AI-allowed call falls through with no advisory and, in "ai" mode, runs
  // silently. Auto mode and the session "always" override run everything
  // silently. With permission "off", the deterministic `confirm` config decides
  // which tools prompt. A declined call comes back as a model-readable reason.
  async function requestGate(
    runMode: AgentMode,
    call: { id: string; name: string; input: unknown },
    aiFlag?: { reason: string },
  ): Promise<{ allow: boolean; reason?: string }> {
    if (runMode === "auto" || confirmAlwaysRef.current) return { allow: true };

    // The AI check flagged this call: escalate to the human box with the reason,
    // regardless of permission mode. Their answer is final.
    if (aiFlag) {
      const ok = await humanConfirm(call, aiFlag.reason);
      return { allow: ok, reason: ok ? undefined : "user declined the call" };
    }

    // In AI mode an AI-allowed call needs no further human confirmation.
    if (config.permission.mode === "ai") return { allow: true };

    // Deterministic confirm gate.
    const setting = config.confirm;
    if (setting === "off") return { allow: true };
    const gated =
      setting === "bash"
        ? call.name === "bash"
        : call.name === "bash" ||
          call.name === "write_file" ||
          call.name === "edit_file";
    if (!gated) return { allow: true };
    const ok = await humanConfirm(call, null);
    return { allow: ok, reason: ok ? undefined : "user declined the call" };
  }

  // ── runaway checkpoint: pauses the unbounded loop to ask "keep going?" ──
  function requestCheckpoint(turn: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      checkpointResolverRef.current = resolve;
      pendingCheckpointRef.current = turn;
      setPendingCheckpoint(turn);
    });
  }
  function resolveCheckpoint(ok: boolean): void {
    const resolve = checkpointResolverRef.current;
    if (!resolve) return;
    checkpointResolverRef.current = null;
    pendingCheckpointRef.current = null;
    setPendingCheckpoint(null);
    resolve(ok);
  }

  // ── ask_user: put a question to the user and pause the loop on its answer ──
  // `askKey` bumps so each ask gets a fresh AskUserView (reset wizard state).
  function requestAsk(questions: AskQuestion[]): Promise<AskAnswer[] | null> {
    return new Promise<AskAnswer[] | null>((resolve) => {
      askResolverRef.current = resolve;
      pendingAskRef.current = questions;
      setPendingAsk(questions);
      setAskKey((k) => k + 1);
    });
  }
  function resolveAsk(answers: AskAnswer[] | null): void {
    const resolve = askResolverRef.current;
    if (!resolve) return;
    askResolverRef.current = null;
    pendingAskRef.current = null;
    setPendingAsk(null);
    resolve(answers);
  }

  /** Decline every open gate so a cancel/abort can propagate cleanly. */
  function declineAllPending(): void {
    if (pendingConfirmRef.current) resolveConfirm(false, false);
    if (pendingCheckpointRef.current !== null) resolveCheckpoint(false);
    if (pendingAskRef.current) resolveAsk(null);
  }

  return {
    pendingConfirm,
    pendingConfirmReason,
    pendingConfirmRef,
    resolveConfirm,
    pendingCheckpoint,
    pendingCheckpointRef,
    requestCheckpoint,
    resolveCheckpoint,
    pendingAsk,
    askKey,
    pendingAskRef,
    requestAsk,
    resolveAsk,
    pendingPlan,
    pendingPlanRef,
    showPlan,
    requestGate,
    declineAllPending,
  };
}
