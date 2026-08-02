defmodule Grappa.RateLimit.Wire do
  @moduledoc """
  GH #630 — the client-facing wire shape for a web-session SEVER,
  broadcast on the severed subject's user topic (`Topic.user/1`)
  immediately before the socket is closed and the auth session revoked.

  cic mirrors this via `wireTypes.ts` (generated from this typespec) and
  dispatches it in `lib/userTopic.ts` to raise a persistent "you were
  disconnected for flooding — sign in again" state that survives the
  socket teardown and drives the re-login banner. The event is a
  best-effort courtesy signal: even if it is dropped, the socket close +
  revoked bearer still force a re-auth (the load-bearing enforcement), cic
  just falls back to its generic logged-out screen.

  `code` is the snake_case sever reason (the "close code" of the #447 wire
  contract). Additive per #447 — a client that doesn't recognise the frame
  ignores it (unknown-is-never-fatal). No `retry_after_ms`: the remedy is
  re-authentication, not waiting.
  """

  @typedoc """
  Broadcast to a subject whose web session was severed for sustained
  inbound flooding (see `Grappa.RateLimit.RequestBudget`).
  """
  @type web_session_severed_event :: %{
          kind: :web_session_severed,
          code: :rate_limit_flood
        }

  @doc """
  Builds the user-topic sever notification. Sole `code` today is
  `:rate_limit_flood`; a closed literal so a new sever cause is a
  deliberate, reviewed wire addition.
  """
  @spec web_session_severed() :: web_session_severed_event()
  def web_session_severed do
    %{kind: :web_session_severed, code: :rate_limit_flood}
  end
end
