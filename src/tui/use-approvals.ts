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
// holds the promise's resolve fn. `requestGate` composes the confirm box with the
// optional AI permission checker. Pulled out of App so the component body stays
// small; this is the project's approved encapsulation boundary (a custom hook).

import { useRef, useState } from "react";
import type { AgentMode } from "../agent.ts";
import type { AskAnswer, AskQuestion } from "../askuser.ts";
import type { Config } from "../config.ts";
import { resolveModel } from "../config.ts";
import { checkCommandSafety, inPermissionScope } from "../permission.ts";
import type { Provider } from "../provider.ts";
import { createProvider } from "../provider.ts";
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
  ) => Promise<{ allow: boolean; reason?: string }>;
  /** Decline every open gate (used by the cancel escalation so an abort can
   *  propagate instead of deadlocking on an unresolved promise). */
  declineAllPending: () => void;
}

export function useApprovals(opts: {
  config: Config;
  note: (text: string, tone?: "info" | "error") => void;
  /** The in-flight run's abort signal, so the AI safety check can be canceled. */
  getSignal: () => AbortSignal | undefined;
}): Approvals {
  const { config, note, getSignal } = opts;

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

  // The AI permission checker (provider + model), resolved lazily on first gated
  // call and cached. `undefined` = not yet resolved; `null` = disabled/unavailable.
  const checkerRef = useRef<{ provider: Provider; model: string } | null>();

  // Resolve (and cache) the AI permission checker. Returns null when permission
  // isn't in "ai" mode or the configured model can't be resolved.
  function getChecker(): { provider: Provider; model: string } | null {
    if (checkerRef.current !== undefined) return checkerRef.current;
    if (config.permission.mode !== "ai") {
      checkerRef.current = null;
      return null;
    }
    const resolved = resolveModel(config, config.permission.model);
    if (!resolved) {
      note(
        `permission model "${config.permission.model}" not found; AI safety check disabled`,
        "error",
      );
      checkerRef.current = null;
      return null;
    }
    try {
      checkerRef.current = {
        provider: createProvider(resolved.providerConfig),
        model: resolved.model.name ?? resolved.model.id,
      };
    } catch (err) {
      note(`AI safety check disabled: ${(err as Error).message}`, "error");
      checkerRef.current = null;
    }
    return checkerRef.current;
  }

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

  // ── the approval gate the agent loop calls before a mutating tool runs ──
  // Auto mode and the session "always" override run everything silently. With
  // permission "ai", the checker model classifies the call: safe runs silently,
  // unsafe escalates to the human y/n/a box (with the reason). With permission
  // "off", the deterministic `confirm` config decides which tools prompt. A
  // declined call comes back as a model-readable reason.
  async function requestGate(
    runMode: AgentMode,
    call: { id: string; name: string; input: unknown },
  ): Promise<{ allow: boolean; reason?: string }> {
    if (runMode === "auto" || confirmAlwaysRef.current) return { allow: true };

    if (config.permission.mode === "ai") {
      if (!inPermissionScope(config.permission.scope, call.name)) {
        return { allow: true };
      }
      const checker = getChecker();
      if (!checker) return { allow: true }; // misconfigured → fail open
      const verdict = await checkCommandSafety(
        checker.provider,
        checker.model,
        call,
        getSignal(),
      );
      if (verdict.safe) return { allow: true };
      const ok = await humanConfirm(call, verdict.reason);
      return { allow: ok, reason: ok ? undefined : "user declined the call" };
    }

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
