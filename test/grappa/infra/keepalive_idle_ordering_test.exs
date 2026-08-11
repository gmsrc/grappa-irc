defmodule Grappa.Infra.KeepaliveIdleOrderingTest do
  @moduledoc """
  #1030 — the nginx→BEAM keepalive pool must be closed by its CLIENT.

  Two idle timers sit on every pooled nginx→Bandit connection: nginx's
  upstream idle (`keepalive_timeout` inside `upstream { }`, default 60s)
  and Bandit's `read_timeout` (thousand_island's between-requests idle,
  default 60_000 ms). With both at the default they are EQUAL, and the
  race is armed: nginx dispatches onto a socket Bandit is closing in the
  same instant, the request dies at the connection layer and nginx has
  only a 502 to report.

  The rule for a keepalive pool is that the pool's client gives up
  FIRST. This guard asserts it as an inequality over the REAL values —
  the confs are parsed, the Elixir side is read out of the merged
  application env — so neither side can drift without reddening.

  ## What this guard CANNOT see

  The m42 production edge terminates TLS in a HOST nginx vhost that is
  the operator's, not this repo's (`infra/snippets/locations-api.conf`
  says so: the includer declares its own `upstream`). Its
  `keepalive_timeout` is unreachable from here and this guard does NOT
  cover it — the repo asserts its own half and no more. Pretending
  otherwise is how a guard ends up green over an unfixed edge.

  Discovery is by glob, not by a hand-kept file list, so a NEW substrate
  is picked up the moment it lands. The blind spot that remains is a
  pool declared in a file shape the globs miss.
  """

  use ExUnit.Case, async: true

  @conf_globs ["infra/**/*.conf", "infra/**/*.sh", "cicchetto/e2e/**/*.conf"]

  describe "nginx→BEAM keepalive pools" do
    test "every in-repo upstream pool pins its idle explicitly" do
      for pool <- pools() do
        assert pool.idle_ms,
               """
               #{pool.file}: upstream `#{pool.name}` keeps a keepalive pool to \
               the BEAM but does not pin `keepalive_timeout` inside the block, \
               so its idle is nginx's default. A default can move under us and \
               the #1030 inequality would vanish silently — pin it.\
               """
      end
    end

    test "Bandit's read_timeout outlives every pinned upstream idle" do
      read_timeout_ms = bandit_read_timeout_ms()

      for pool <- pools(), is_integer(pool.idle_ms) do
        assert read_timeout_ms > pool.idle_ms,
               """
               #{pool.file}: upstream `#{pool.name}` idles for #{pool.idle_ms} ms \
               while Bandit's read_timeout is #{read_timeout_ms} ms. The pool's \
               CLIENT must give up first (#1030) — with the server closing at or \
               before nginx, nginx dispatches onto a dying socket and answers 502.\
               """
      end
    end

    # Anti-vacuity. The two assertions above iterate `pools()`, so a glob that
    # stops matching turns both of them green over nothing. This is the one
    # place a hand-kept list is right: a substrate leaving the repo (as
    # infra/freebsd/nginx.conf did) SHOULD force a deliberate edit here.
    test "the discovery globs still find the known substrates" do
      files = pools() |> Enum.map(& &1.file) |> MapSet.new()

      for known <- [
            "infra/linux/nginx.conf",
            "infra/cloud/first-boot.sh",
            "infra/nginx-tls-frontend.example.conf",
            "cicchetto/e2e/nginx-test.conf"
          ] do
        assert known in files,
               "#{known} declares a keepalive pool to the BEAM but the globs no longer reach it"
      end
    end
  end

  # The value Bandit actually receives: Phoenix hands the `:http` keyword
  # list straight to `Bandit.child_spec/1`, which validates `read_timeout`
  # under `:thousand_island_options` (Bandit.PhoenixAdapter.child_specs/2 →
  # Bandit.start_link/1). Reading the MERGED application env rather than
  # grepping config.exs is deliberate: the value is declared once in
  # config.exs and reaches the endpoint through Config's keyword deep-merge,
  # and only the merged read witnesses that the merge happened.
  defp bandit_read_timeout_ms do
    :grappa
    |> Application.fetch_env!(GrappaWeb.Endpoint)
    |> Keyword.fetch!(:http)
    |> Keyword.fetch!(:thousand_island_options)
    |> Keyword.fetch!(:read_timeout)
  end

  defp pools do
    for path <- Enum.flat_map(@conf_globs, &Path.wildcard/1),
        {name, body} <- path |> File.read!() |> strip_comments() |> upstream_blocks(),
        pooled?(body) do
      %{file: path, name: name, idle_ms: idle_ms(body)}
    end
  end

  # Both nginx and sh comment with `#`. Dropping them before the parse keeps
  # prose about an upstream block from being read as one — and makes a
  # commented-out `keepalive_timeout` correctly count as absent.
  defp strip_comments(source) do
    source
    |> String.split("\n")
    |> Enum.reject(&String.starts_with?(String.trim_leading(&1), "#"))
    |> Enum.join("\n")
  end

  # nginx upstream blocks hold no nested braces, so a run of non-`}` bytes is
  # the whole body.
  defp upstream_blocks(source) do
    ~r/upstream\s+(\S+)\s*\{([^}]*)\}/
    |> Regex.scan(source)
    |> Enum.map(fn [_all, name, body] -> {name, body} end)
  end

  # `keepalive <n>;` (the pool-size directive) is what makes the connection
  # pooled — and therefore raceable. An upstream without it opens a fresh
  # socket per request and has no idle timer to order.
  defp pooled?(body), do: Regex.match?(~r/^\s*keepalive\s+\d+\s*;/m, body)

  defp idle_ms(body) do
    case Regex.run(~r/^\s*keepalive_timeout\s+(\d+)(ms|s|m|h)?\s*;/m, body) do
      nil -> nil
      [_all, value] -> String.to_integer(value) * 1000
      [_all, value, unit] -> String.to_integer(value) * unit_ms(unit)
    end
  end

  # nginx time units; a bare number is seconds.
  defp unit_ms("ms"), do: 1
  defp unit_ms("s"), do: 1000
  defp unit_ms("m"), do: 60 * 1000
  defp unit_ms("h"), do: 60 * 60 * 1000
end
