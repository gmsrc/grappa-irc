defmodule GrappaWeb.InvitesController do
  @moduledoc """
  Inbound-invite refusal (#976).

  `DELETE /networks/:network_id/invites/:channel_id` drops the `:invited`
  window the session holds for `channel_id` and fans the drop out on the
  user topic (`window_invite_declined`) so every device of the subject
  loses the banner — the `:invited` state is per-session and reaches the
  clients by broadcast, so a decline that did not fan out would leave the
  other device re-showing the invite on its next reload.

  **Nothing is sent upstream.** IRC has no DECLINE verb; the invite exists
  only as session-local window state plus the persisted `:server_event` row
  that recorded it. The peer learns nothing, and the client copy says so.

  Why the invite is its own resource rather than a verb on
  `/channels/:channel_id`: accepting an invite is already `POST /channels`
  (a JOIN), so deleting the OFFER and deleting the MEMBERSHIP are different
  nouns. Same subject-dispatch + `ResolveNetwork` pipeline as
  `ChannelsController` — see its moduledoc for the plumbing.

  `{:error, :not_invited}` (the channel is `:joined` / `:kicked` / unknown)
  surfaces as 404: this door is channel-keyed and REST-reachable, so it must
  never double as a way to erase a window the operator is actually using.
  """
  use GrappaWeb, :controller

  import GrappaWeb.Validation, only: [validate_channel_name: 1]

  alias Grappa.Session
  alias GrappaWeb.Subject

  @doc """
  `DELETE /networks/:network_id/invites/:channel_id` — declines the invite.

  200 + `{"ok": true}`, not 202: unlike JOIN/PART there is no upstream
  round-trip to await, so the state change is fully applied (and already
  broadcast) by the time this returns.
  """
  @spec delete(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :no_session | :invalid_line | :not_invited}
  def delete(conn, %{"channel_id" => channel}) do
    subject = Subject.to_session(conn.assigns.current_subject)
    network = conn.assigns.network

    with :ok <- validate_channel_name(channel),
         :ok <- Session.decline_invite(subject, network.id, channel) do
      json(conn, %{ok: true})
    end
  end
end
