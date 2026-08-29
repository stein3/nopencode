<script lang="ts">
  import { onMount } from 'svelte'
  import { oc } from '../lib/api'
  import { toast } from '../lib/stores'

  interface McpServer {
    type?: string
    status?: string
    enabled?: boolean
  }

  let servers: Record<string, McpServer> = {}
  let loading = true
  let toggling: Record<string, boolean> = {}

  function isOn(s: McpServer): boolean {
    return s.status === 'connected' || s.enabled === true
  }

  function statusColor(s: McpServer): string {
    if (s.status === 'connected') return 'connected'
    if (s.status === 'connecting' || s.status === 'pending') return 'pending'
    return 'disconnected'
  }

  async function refresh() {
    loading = true
    try {
      servers = await oc.mcps()
    } catch {
      servers = {}
    }
    loading = false
  }

  async function toggle(name: string) {
    const cur = servers[name]
    if (!cur) return
    const connect = !isOn(cur)
    toggling = { ...toggling, [name]: true }
    try {
      await oc.mcpToggle(name, connect)
      toast(`${name} ${connect ? 'connect requested' : 'disconnect requested'}`)
      await refresh()
    } catch (e: any) {
      toast(`toggle failed: ${e.message ?? e}`)
    } finally {
      toggling = { ...toggling, [name]: false }
    }
  }

  onMount(refresh)
</script>

<aside class="mcp">
  <div class="head">
    <span class="ttl">MCP Servers</span>
    <button class="refresh" title="Refresh" on:click={refresh}>↻</button>
  </div>

  {#if loading}
    <div class="empty">loading…</div>
  {:else}
    {#each Object.entries(servers) as [name, srv] (name)}
      <div class="row">
        <span class="dot {statusColor(srv)}"></span>
        <div class="info">
          <span class="name">{name}</span>
          <span class="meta">{srv.type ?? 'local'} · {srv.status ?? 'unknown'}</span>
        </div>
        <label class="switch-wrap">
          <input
            class="native"
            type="checkbox"
            checked={isOn(srv)}
            disabled={toggling[name]}
            on:change={() => toggle(name)}
          />
          <span class="switch" aria-hidden="true"></span>
        </label>
      </div>
    {:else}
      <div class="empty">No MCP servers configured</div>
    {/each}
  {/if}
</aside>

<style>
  .mcp {
    width: 240px;
    flex-shrink: 0;
    background: var(--bg-panel);
    border-left: 1px solid var(--border);
    padding: 12px;
    overflow-y: auto;
    height: 100vh;
    box-sizing: border-box;
  }
  @supports (height: 100dvh) {
    .mcp {
      height: var(--vvh, 100dvh);
    }
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .head .ttl {
    font-weight: 600;
    font-size: 13px;
  }
  .head .refresh {
    background: none;
    border: none;
    color: var(--fg-dim);
    font-size: 15px;
    cursor: pointer;
    padding: 0 2px;
    line-height: 1;
  }
  .head .refresh:hover {
    color: var(--fg);
  }
  .empty {
    color: var(--fg-dim);
    font-size: 12px;
    padding: 2px 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
  }
  .row + .row {
    border-top: 1px solid var(--border);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dot.connected {
    background: var(--ok);
  }
  .dot.pending {
    background: var(--warn);
  }
  .dot.disconnected {
    background: var(--fg-dim);
    opacity: 0.45;
  }
  .info {
    min-width: 0;
    flex: 1;
  }
  .name {
    display: block;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    display: block;
    font-size: 10.5px;
    color: var(--fg-dim);
  }
  /* switch — same pattern as Settings.svelte */
  .switch-wrap {
    position: relative;
    flex: none;
  }
  .native {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
    pointer-events: none;
  }
  .switch {
    display: block;
    position: relative;
    width: 34px;
    height: 18px;
    border-radius: 9px;
    background: var(--bg-hover);
    border: 1px solid var(--border);
    transition: background 0.12s ease-out;
    cursor: pointer;
  }
  .switch::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--fg-dim);
    transition: transform 0.12s ease-out, background 0.12s ease-out;
  }
  .native:checked + .switch {
    background: color-mix(in srgb, var(--accent) 32%, transparent);
    border-color: var(--accent);
  }
  .native:checked + .switch::after {
    transform: translateX(16px);
    background: var(--accent);
  }
  .native:focus-visible + .switch {
    outline: 1px solid var(--accent);
    outline-offset: 2px;
  }
  .native:disabled + .switch {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
