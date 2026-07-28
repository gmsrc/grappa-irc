defmodule GrappaWeb.Plugs.SecurityHeadersTest do
  @moduledoc """
  #485 — the security-header set moved off nginx into the app. This plug
  is now the SINGLE source of truth for CSP + the four sibling headers on
  every substrate (Docker single-container, the m42 bastille jail, the
  operator's own TLS front door). nginx — where it survives (jail + e2e) —
  is a dumb reverse proxy that emits none of these.

  The golden literal below is the CSP that shipped byte-for-byte in the
  retired `infra/snippets/security-headers.conf`. It is intentionally
  hardcoded here (not read from the plug) so this test PINS the plug
  against drift — a characterization contract, not a mirror.
  """
  use ExUnit.Case, async: true

  import Plug.{Conn, Test}

  alias GrappaWeb.Plugs.SecurityHeaders

  # Byte-identical to the deleted nginx snippet's Content-Security-Policy
  # value. If the app must change the policy, change it in ONE place
  # (the plug) and update this pin deliberately.
  @golden_csp "default-src 'self'; connect-src 'self' https://challenges.cloudflare.com https://*.hcaptcha.com https://litterbox.catbox.moe; script-src 'self' 'sha256-ZswfTY7H35rbv8WC7NXBoiC7WNu86vSzCDChNWwZZDM=' https://challenges.cloudflare.com https://*.hcaptcha.com; style-src 'self' 'unsafe-inline' https://*.hcaptcha.com; img-src 'self' data:; font-src 'self'; manifest-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-src https://challenges.cloudflare.com https://*.hcaptcha.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

  defp sent(status) do
    :get
    |> conn("/")
    |> SecurityHeaders.call(SecurityHeaders.init([]))
    |> send_resp(status, "body")
  end

  test "csp/0 is byte-identical to the retired nginx snippet" do
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
