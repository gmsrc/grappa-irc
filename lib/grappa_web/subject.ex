defmodule GrappaWeb.Subject do
  @moduledoc """
  Web-layer subject discriminator (M-web-1).

  `GrappaWeb.Plugs.Authn` assigns a single `:current_subject` tagged
  tuple carrying the loaded subject struct:

      {:user, %Grappa.Accounts.User{}} | {:visitor, %Grappa.Visitors.Visitor{}}

  This is the controller-side view: rich enough that consumers don't
  re-fetch and don't drift from a parallel `:current_user` /
  `:current_visitor` assign (which is what M-web-1 closes — the
  KeyError race when one is set and the other isn't).

  The Session / Scrollback boundary (`t:Grappa.Session.subject/0`) speaks
  the leaner `{:user, id} | {:visitor, id}` shape; controllers
  delegating downstream call `to_session/1` to convert.
  """

  alias Grappa.Accounts.User
  alias Grappa.Visitors.Visitor

  @typedoc "Web-layer subject — carries the loaded struct."
  @type t :: {:user, User.t()} | {:visitor, Visitor.t()}

  @doc """
  Convert a web-layer subject tuple to the Session/Scrollback boundary
  shape (`t:Grappa.Session.subject/0` — bare-id tuple).
  """
  @spec to_session(t()) :: Grappa.Session.subject()
  def to_session({:user, %User{id: id}}), do: {:user, id}
  def to_session({:visitor, %Visitor{id: id}}), do: {:visitor, id}

  @doc """
  Derive the user_name segment of a `Grappa.PubSub.Topic` from a
  web-layer subject.

  Extracts the label parts from the loaded struct (`user.name` /
  `visitor.id`) and delegates the encoding to the shared
  `Grappa.Subject.label/1` codec (#413) — this module no longer keeps
  a parallel `"visitor:"` prefix. Every cross-device broadcast
  (`ReadCursor.broadcast_set/5`, archive invalidations, `notify_list`,
  …) routes on the topic built from this label; one codec shared with
  the core sites is what stops the producing and consuming sides from
  drifting.

  A `nil` user name is an invariant violation (an authenticated user
  always has a name; the schema types the field nilable only for the
  pre-insert changeset window) and raises `FunctionClauseError` rather
  than building the malformed `"grappa:user:"` topic — fail loud, per
  the boundary-rejection rule.
  """
  @spec topic_label(t()) :: String.t()
  def topic_label({:user, %User{name: name}}) when is_binary(name),
    do: Grappa.Subject.label({:user, name})

  def topic_label({:visitor, %Visitor{id: id}}) when is_binary(id),
    do: Grappa.Subject.label({:visitor, id})

  @doc """
  Classify a topic-label string back into its subject-label parts —
  delegates to the shared `Grappa.Subject.from_label/1` codec (#413),
  the inverse of `topic_label/1` on the label alone.

  `"visitor:" <> id` decodes to `{:visitor, id}`; any other string is a
  `{:user, name}`. Returns the classified *label* parts, NOT a loaded
  subject: the user branch yields the bare name for the caller to
  DB-resolve (a deleted-row race is that caller's concern, e.g.
  `GrappaWeb.GrappaChannel.resolve_subject/1`).
  """
  @spec from_topic_label(String.t()) :: Grappa.Subject.label_parts()
  defdelegate from_topic_label(label), to: Grappa.Subject, as: :from_label
end
