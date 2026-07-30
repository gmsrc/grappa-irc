defmodule Grappa.LiveIntrospection.SessionEntry do
  @moduledoc """
  Typed snapshot of one live `Grappa.Session.Server` for the
  operator surface. One struct, two doors: `Grappa.Operator`'s
  tab-separated text formatters AND `GrappaWeb.Admin.*Controller`'s
  JSON wires both consume this — one feature, one code path.

  ## Field semantics

    * `subject` — `{:user, uuid}` or `{:visitor, uuid}` (the
      `Grappa.Session.subject()` parity-typed key).
    * `network_id` — integer FK to `networks`.
    * `pid` — live BEAM pid; the wire layer renders it via
      `inspect/1` for human-readable display only (cic must NEVER
      re-parse it).
    * `alive` — `Process.alive?/1` snapshot at sampling time.
    * `mailbox_len` — `:message_queue_len` from `Process.info/2`.
      The #1 thing operators chase on a stuck session.
    * `memory_bytes` — `:memory` from `Process.info/2`.
    * `joined_channels` — currently-joined channel list per
      `Grappa.Session.list_channels/2`. `nil` when the GenServer
      call timed out (busy / mailbox-bloated pid — see
      `introspection_degraded`).
    * `peer_address` — the upstream peer IP (v6/v4) the session's
      IRC socket is connected to, as a string, per
      `Grappa.Session.peer_address/3` (#550, netsplit triage). `nil`
      when the session is not connected (pre-connect, mid-reconnect,
      socket just closed) OR the call timed out — both add
      `:peer_address` to `introspection_degraded`. Never a fabricated
      or stale address.
    * `peer_port` — the peer TCP port alongside `peer_address`; `nil`
      whenever `peer_address` is.
    * `introspection_degraded` — atom allowlist marking which
      sub-fields fell back to a degraded shape (`:joined_channels`,
      `:peer_address`). The wire layer surfaces this so the operator
      sees "this session is sick / not connected" rather than "this
      session has no channels / no upstream."
  """

  @enforce_keys [
    :subject,
    :network_id,
    :pid,
    :alive,
    :mailbox_len,
    :memory_bytes,
    :joined_channels,
    :peer_address,
    :peer_port,
    :introspection_degraded
  ]

  defstruct [
    :subject,
    :network_id,
    :pid,
    :alive,
    :mailbox_len,
    :memory_bytes,
    :joined_channels,
    :peer_address,
    :peer_port,
    :introspection_degraded
  ]

  @type degraded_field :: :joined_channels | :peer_address

  @type t :: %__MODULE__{
          subject: Grappa.Session.subject(),
          network_id: pos_integer(),
          pid: pid(),
          alive: boolean(),
          mailbox_len: non_neg_integer(),
          memory_bytes: non_neg_integer(),
          joined_channels: [String.t()] | nil,
          peer_address: String.t() | nil,
          peer_port: :inet.port_number() | nil,
          introspection_degraded: [degraded_field()]
        }
end
