import type { Component } from "solid-js";

// Admin redesign Layer 2 — the 7 byte-identical copies of
// "failed: … — click ↻ refresh to retry" (and the loading/empty
// siblings) collapse into three small components. Each still takes
// its own `data-testid` so every tab keeps its existing e2e/vitest
// contract.

export type ErrorProps = {
  message: string;
  testId?: string;
};

export const AdminError: Component<ErrorProps> = (props) => (
  <p class="adm-error" role="alert" data-testid={props.testId}>
    failed: {props.message} — click ↻ refresh to retry
  </p>
);

export type EmptyProps = {
  message: string;
  testId?: string;
};

export const AdminEmpty: Component<EmptyProps> = (props) => (
  <p class="adm-empty" data-testid={props.testId}>
    {props.message}
  </p>
);

export type LoadingProps = {
  message?: string;
  testId?: string;
};

export const AdminLoading: Component<LoadingProps> = (props) => (
  <p class="adm-loading" data-testid={props.testId}>
    {props.message ?? "loading…"}
  </p>
);
