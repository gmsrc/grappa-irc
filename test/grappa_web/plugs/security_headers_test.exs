defmodule GrappaWeb.Plugs.SecurityHeadersTest do
  @moduledoc """
  #485 — the security-header set moved off nginx into the app. This plug
  is now the SINGLE source of truth for CSP + the four sibling headers on
  every substrate (Docker single-container, the m42 bastille jail, the
  operator's own TLS front door). nginx — where it survives (jail + e2e) —
  is a dumb reverse proxy that emits none of these.

  The golden literal below started as the CSP that shipped byte-for-byte
  in the retired `infra/snippets/security-headers.conf`; #607 widened
  `media-src` to `https:` (external audio in the docked mini-player) and
  #1240 widened `img-src` the same way (cross-host images in the media
  viewer) — deliberate, pinned deviations. It is intentionally hardcoded
  here (not read from the plug) so this test PINS the plug against drift —
  a characterization contract, not a mirror.
  """
  use ExUnit.Case, async: true

  import Plug.{Conn, Test}

  alias GrappaWeb.Plugs.SecurityHeaders

  # The plug's Content-Security-Policy SSOT (was byte-identical to the
  # deleted nginx snippet; #607 widened media-src to https:, #1240 img-src).
  # If the app must change the policy, change it in ONE place (the plug) and
  # update this pin deliberately.
  @golden_csp "default-src 'self'; connect-src 'self' https://challenges.cloudflare.com https://*.hcaptcha.com https://litterbox.catbox.moe; script-src 'self' 'sha256-ZswfTY7H35rbv8WC7NXBoiC7WNu86vSzCDChNWwZZDM=' https://challenges.cloudflare.com https://*.hcaptcha.com; style-src 'self' 'unsafe-inline' https://*.hcaptcha.com; img-src 'self' data: https:; font-src 'self'; manifest-src 'self'; media-src 'self' blob: https:; worker-src 'self' blob:; frame-src https://challenges.cloudflare.com https://*.hcaptcha.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

  defp sent(status) do
    :get
    |> conn("/")
    |> SecurityHeaders.call(SecurityHeaders.init([]))
    |> send_resp(status, "body")
  end

  # Parse the EMITTED policy into %{directive => MapSet.t(source)}. The golden
  # pin above catches byte drift; the #1695 tests below need to ask what a
  # directive ADMITS, and re-typing the expected string to answer that would
  # make them mirrors of the implementation instead of assertions about it.
  defp directives do
    SecurityHeaders.csp()
    |> String.split(";", trim: true)
    |> Map.new(fn directive ->
      [name | sources] = directive |> String.trim() |> String.split(" ", trim: true)
      {name, MapSet.new(sources)}
    end)
  end

  describe "#1695 — the SomaFM catalogue host on connect-src" do
    # Measured against the live catalogue (46 channels, 425 absolute URLs,
    # 2026-08-23): the 184 `.pls` playlist URLs — the only kind a client
    # FETCHES, and so the only kind `connect-src` governs — are 184/184 on
    # `api.somafm.com`. The 138 logos ride `img-src https:` and the 103
    # prerolls ride `media-src https:`, both already wide enough, and the
    # prerolls are the only thing on the bare `somafm.com` at all.
    test "connect-src admits the catalogue host" do
      assert MapSet.member?(directives()["connect-src"], "https://api.somafm.com"),
             "connect-src must admit https://api.somafm.com — it is the host every " <>
               "connect-src-governed SomaFM URL lives on."
    end

    # `https://*.somafm.com` (the issue TITLE's spelling) is wider than the
    # measurement: it admits every present and future somafm subdomain —
    # ice/ice2..6, hls — for `fetch`, and not one of them appears in the
    # catalogue's connect-src set. It also does NOT match the bare
    # `somafm.com` (a CSP host-source with `*.` requires at least one label),
    # so it buys nothing for the prerolls either. Widening past the measured
    # host is a security regression, not a convenience.
    test "connect-src stays at the measured host, not a somafm wildcard" do
      somafm =
        directives()["connect-src"]
        |> Enum.filter(&String.contains?(&1, "somafm.com"))
        |> Enum.sort()

      assert somafm == ["https://api.somafm.com"],
             "connect-src must carry exactly the measured host and no wildcard; got " <>
               inspect(somafm)
    end

    # #1695 is a one-token change. Its own verification step says so: the
    # logos and prerolls already pass on directives that must not move.
    test "no directive other than connect-src gained a somafm source" do
      leaked =
        for {name, sources} <- directives(),
            name != "connect-src",
            source <- sources,
            String.contains?(source, "somafm"),
            do: {name, source}

      assert leaked == [],
             "only connect-src needed widening; somafm leaked into " <> inspect(leaked)
    end
  end

  test "csp/0 matches the golden pin (SSOT, incl. the #607 media-src + #1240 img-src https: widenings)" do
    assert SecurityHeaders.csp() == @golden_csp
  end

  test "emits the CSP header on a 2xx response" do
    assert get_resp_header(sent(200), "content-security-policy") == [@golden_csp]
  end

  test "emits the full sibling header set (verbatim from the snippet)" do
    conn = sent(200)
    assert get_resp_header(conn, "x-content-type-options") == ["nosniff"]
    assert get_resp_header(conn, "referrer-policy") == ["same-origin"]
    assert get_resp_header(conn, "x-frame-options") == ["DENY"]

    assert get_resp_header(conn, "permissions-policy") ==
             ["geolocation=(), microphone=(), camera=(), payment=(), usb=()"]
  end

  test "headers land on a non-2xx response too (nginx `always` parity)" do
    assert get_resp_header(sent(404), "content-security-policy") == [@golden_csp]
    assert get_resp_header(sent(500), "x-frame-options") == ["DENY"]
  end

  test "the plug is the sole owner — its value wins over a downstream header" do
    conn =
      :get
      |> conn("/")
      |> SecurityHeaders.call(SecurityHeaders.init([]))
      |> put_resp_header("x-frame-options", "SAMEORIGIN")
      |> send_resp(200, "body")

    assert get_resp_header(conn, "x-frame-options") == ["DENY"]
  end
end
