defmodule GrappaWeb.SpaServingTest do
  @moduledoc """
  #399 Part 1 — the embedded Phoenix web server self-serves the built
  cicchetto SPA bundle (static assets + history-mode deep-link
  fallback), so a plain `bin/grappa start` on an HTTP port yields a
  working instance without nginx in front.

  These dispatch through the FULL endpoint pipeline (ConnCase's
  `@endpoint`), so `Plug.Static` (endpoint) + the SPA catch-all route
  are both exercised. `async: false` because the "bundle absent" case
  mutates the process-global `Grappa.Cic.Bundle.root/0`
  (`:persistent_term`), which cannot race concurrent tests.
  """
  use GrappaWeb.ConnCase, async: false

  alias Grappa.Cic.Bundle
  alias GrappaWeb.Plugs.SecurityHeaders

  # The committed fixture bundle wired via `config/test.exs`
  # `:cic_dist_root`. Booted at app start like the real dist dir.
  defp html_conn, do: put_req_header(build_conn(), "accept", "text/html")

  describe "static asset serving (Plug.Static from the cic dist)" do
    test "GET /assets/<hashed>.js serves the built asset" do
      conn = get(build_conn(), "/assets/index-TESTHASH.js")
      assert conn.status == 200
      assert conn.resp_body =~ "cicchetto test asset"
      assert ["text/javascript" <> _] = get_resp_header(conn, "content-type")
    end

    test "GET /backgrounds/<key>.webp serves the image with a far-future immutable cache" do
      # #485 — nginx's `location /backgrounds/ { expires max; }` moved to
      # the BEAM: system-owned, content-addressable-ish keys never re-fetch.
      conn = get(build_conn(), "/backgrounds/01-test-dark.webp")
      assert conn.status == 200
      assert [cache_control] = get_resp_header(conn, "cache-control")
      assert cache_control =~ "max-age=315360000"
      assert cache_control =~ "immutable"
    end

    test "GET /fonts/<file>.woff2 serves the built font (allowlist lockstep)" do
      conn = get(build_conn(), "/fonts/test-mono.woff2")
      assert conn.status == 200
      assert ["font/woff2" <> _] = get_resp_header(conn, "content-type")
    end

    test "GET /icon.svg serves the root-level public icon (allowlist lockstep)" do
      conn = get(build_conn(), "/icon.svg")
      assert conn.status == 200
      assert ["image/svg+xml" <> _] = get_resp_header(conn, "content-type")
    end

    test "GET /manifest.webmanifest serves the PWA manifest" do
      conn = get(build_conn(), "/manifest.webmanifest")
      assert conn.status == 200
      assert ["application/manifest+json" <> _] = get_resp_header(conn, "content-type")
    end

    test "GET /service-worker.js serves the SW with a no-cache policy" do
      conn = get(build_conn(), "/service-worker.js")
      assert conn.status == 200
      assert conn.resp_body =~ "test service worker"
      assert [cache_control] = get_resp_header(conn, "cache-control")
      assert cache_control =~ "no-cache"
    end
  end

  describe "SPA history-mode fallback" do
    test "GET / serves index.html" do
      conn = get(html_conn(), "/")
      assert conn.status == 200
      assert conn.resp_body =~ "cic-app-root"
      assert ["text/html" <> _] = get_resp_header(conn, "content-type")
    end

    test "GET /a/client/deep/link serves index.html for a browser navigation" do
      conn = get(html_conn(), "/theme/some-shared-id")
      assert conn.status == 200
      assert conn.resp_body =~ "cic-app-root"
    end

    test "GET / with a bare */* Accept (curl / fetch default) serves the shell" do
      conn =
        build_conn()
        |> put_req_header("accept", "*/*")
        |> get("/")

      assert conn.status == 200
      assert conn.resp_body =~ "cic-app-root"
    end

    test "a non-HTML request to an unknown path 404s (no index.html for API clients)" do
      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/definitely/not/a/route")

      assert conn.status == 404
      refute conn.resp_body =~ "cic-app-root"
    end
  end

  describe "security headers (#485 — the plug is the sole owner; nginx parity)" do
    # Every response the BEAM self-serves now carries the header set that
    # used to live in infra/snippets/security-headers.conf. SecurityHeaders
    # runs before Plug.Static, so a static HIT (send+halt) carries them too.
    test "GET / (SPA shell) carries the full security-header set" do
      conn = get(html_conn(), "/")
      assert conn.status == 200
      assert get_resp_header(conn, "content-security-policy") == [SecurityHeaders.csp()]
      assert get_resp_header(conn, "x-content-type-options") == ["nosniff"]
      assert get_resp_header(conn, "referrer-policy") == ["same-origin"]
      assert get_resp_header(conn, "x-frame-options") == ["DENY"]
    end

    test "GET /service-worker.js carries security headers AND stays no-cache" do
      conn = get(build_conn(), "/service-worker.js")
      assert conn.status == 200
      assert get_resp_header(conn, "content-security-policy") == [SecurityHeaders.csp()]
      assert [cache_control] = get_resp_header(conn, "cache-control")
      assert cache_control =~ "no-cache"
    end

    test "a hashed static asset (Plug.Static send+halt path) carries security headers" do
      conn = get(build_conn(), "/assets/index-TESTHASH.js")
      assert conn.status == 200
      assert get_resp_header(conn, "content-security-policy") == [SecurityHeaders.csp()]
    end

    test "a JSON error response carries security headers (nginx `always` parity)" do
      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/api/server-settings")

      assert conn.status == 401
      assert get_resp_header(conn, "content-security-policy") == [SecurityHeaders.csp()]
    end
  end

  describe "the SPA fallback never shadows real routes" do
    test "GET /healthz still answers the health check" do
      conn = get(html_conn(), "/healthz")
      assert conn.status == 200
      refute conn.resp_body =~ "cic-app-root"
    end

    test "an authenticated API route still 401s as JSON (not index.html)" do
      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/api/server-settings")

      assert conn.status == 401
      refute conn.resp_body =~ "cic-app-root"
    end

    test "GET /uploads/:slug still routes to the uploads controller (404 JSON, not index.html)" do
      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/uploads/notavalidslugatall")

      assert conn.status == 404
      refute conn.resp_body =~ "cic-app-root"
    end
  end

  describe "bundle absent (dev/CI before a cic build)" do
    test "GET / returns 404, not a 500" do
      original = Bundle.root()
      tmp = Path.join(System.tmp_dir!(), "cic-absent-#{System.unique_integer([:positive])}")
      on_exit(fn -> Bundle.boot(original) end)
      Bundle.boot(tmp)

      conn = get(html_conn(), "/")
      assert conn.status == 404
    end
  end
end
