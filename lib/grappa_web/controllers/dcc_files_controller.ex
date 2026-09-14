defmodule GrappaWeb.DccFilesController do
  @moduledoc """
  Serving a DCC file the operator accepted (issue 2089).

  A sibling of `GrappaWeb.DccOffersController` rather than an action on
  it, because the two are different resources with different lifetimes: an
  OFFER is per-session memory whose hold runs out in minutes and dies with
  the process, a FILE is bytes on disk with a retention the reaper
  enforces. One controller with a mode would be the shared data model with
  a type flag.

  ## Exactly the public `/uploads/:slug` shape (issue 2127 ruling)

  🔴 This route USED to sit behind `:authn` + `ResolveNetwork`, on the
  reasoning that a stranger's bytes are not something the operator chose
  to publish. That reasoning is retired, on two counts.

  It did not WORK. `GrappaWeb.Plugs.Authn` reads only an
  `authorization: Bearer <uuid>` header — no cookie, no query parameter —
  cicchetto keeps that token in `localStorage` and never touches
  `document.cookie`, and a scrollback link renders as
  `<a target="_blank">`. So a tap opened a tab carrying no
  `Authorization` header and collected a 401, which is what issue 2127
  was filed about: the delivery row's link was unusable, and no shape of
  URL buys its way out of a gate the browser cannot satisfy.

  And its premise was wrong. By the time bytes are on disk here, the
  operator has EXPLICITLY accepted this file from this nick — the consent
  the old comment said was missing is exactly what `Grappa.Dcc.Policy`
  demanded before a socket was opened. So the route moved to the same
  top-level `pipe_through [:api]` surface as `GET /uploads/:slug`, and
  what carries the access is what carries it there: the **26-char base32
  slug, 128 bits of entropy**, minted server-side by `Grappa.Dcc` and
  never derived from the peer's filename.

  Consequence, stated because it is the point and not a side effect:
  anyone holding the URL can fetch the file without logging in, until the
  retention reaper takes it. `Grappa.Dcc.Reaper` is therefore the only
  revocation there is.

  ## The three response headers are the security posture

  `application/octet-stream` + `Content-Disposition: attachment` +
  `X-Content-Type-Options: nosniff`, always, with no branch. The peer
  declared no MIME type — a `DCC SEND` carries a filename, an address, a
  port and a size, and nothing else — so there is nothing to echo even if
  echoing it were safe, and the schema deliberately has no `mime` column
  to be tempted by. Anything that lets a browser decide for itself what
  these bytes are turns the spool into a stored-XSS door on the operator's
  own origin. The filename in the disposition is the NEUTRALISED one the
  banner and the scrollback row used.

  Ungating the route makes these three MORE load-bearing, not less: the
  pipeline no longer stands between a hostile payload and a browser, so
  they are the whole of what does. In particular the URL may now end in
  `.html` or `.svg` — issue 2127 mints a whitelisted extension off the
  peer's declared filename — and that extension is decoration only. It
  never reaches the lookup (`GrappaWeb.Validation.slug_from_path/1`
  strips it) and it never touches the content type, which has no branch
  to take.
  """
  use GrappaWeb, :controller

  # Registers `@sobelow_skip` so the annotation on `show/2` below does not
  # warn as an unused module attribute — same line, same reason, as
  # `GrappaWeb.NetworksController`.
  Module.register_attribute(__MODULE__, :sobelow_skip, accumulate: true, persist: true)

  alias Grappa.Dcc
  alias GrappaWeb.Validation

  @doc """
  `GET /dcc_files/:slug[.ext]` — the accepted file's bytes.

  200 with the bytes; 404 for a malformed slug, a missing row, an expired
  row, and a row whose file is gone. One collapsed answer with no oracle
  — the same posture `UploadsController.show/2` takes, and for the same
  reason: a distinguishing 404 would turn the serving route into a probe
  for which slugs exist.

  The extension is stripped before the lookup
  (`Validation.slug_from_path/1`, shared with `UploadsController`): the
  **lookup is on the 26 characters only**, so a client may append
  anything the minter admits and still address the same row, and nothing
  the peer named can widen what is read.

  `path` comes from `Dcc.storage_path/1`, which RAISES on anything that is
  not the 26-char minted shape before joining it — so the peer's own
  filename, which is stored as display metadata and never as a path,
  cannot reach `File.read/1` even in principle. `bytes` is opaque content
  served as an attachment; Sobelow cannot follow either provenance across
  the module boundary.
  """
  @sobelow_skip ["Traversal.FileModule", "XSS.SendResp"]
  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show(conn, %{"slug" => slug}) when is_binary(slug) do
    with {:ok, row} <- Dcc.get_by_slug(Validation.slug_from_path(slug)),
         {:ok, bytes} <- File.read(Dcc.storage_path(row.slug)) do
      conn
      |> put_resp_header("content-type", "application/octet-stream")
      |> put_resp_header("content-disposition", disposition(row.filename))
      |> put_resp_header("x-content-type-options", "nosniff")
      # `private`, where `/uploads/:slug` says `public` — the one place
      # the two surfaces still differ, and deliberately. The slug is the
      # credential on both, but these bytes arrived unsolicited from a
      # stranger and the operator accepted them for THEMSELVES; letting a
      # shared proxy hold a copy widens who has them beyond whoever holds
      # the URL, which is the only bound this route has left.
      |> put_resp_header("cache-control", "private, max-age=3600")
      |> send_resp(200, bytes)
    else
      _ -> not_found(conn)
    end
  end

  def show(conn, _), do: not_found(conn)

  # RFC 6266 `filename*` in UTF-8, plus a bare `filename` fallback with
  # every quote and backslash stripped. The stored name is already
  # neutralised for CONTROL bytes by `Grappa.Dcc.Report.display_filename/1`
  # — this strips what would break the HEADER, which is a different
  # alphabet and therefore a second pass rather than a duplicated one.
  defp disposition(filename) do
    bare = String.replace(filename, ~r/["\\]/, "")
    ~s{attachment; filename="#{bare}"; filename*=UTF-8''#{URI.encode_www_form(filename)}}
  end

  defp not_found(conn), do: conn |> put_status(:not_found) |> json(%{error: "not_found"})
end
