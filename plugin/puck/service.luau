--!nonstrict
-- Headless poller. Every 5 s it reads T3's thread snapshot and publishes a
-- summary as noctalia.state "status"; once a minute it asks `puck spend` for
-- today's spend and publishes it as "spend". The widget and panel only render.

local POLL_MS = 5000
local SPEND_EVERY = 12 -- polls between spend refreshes (one minute)

local home = noctalia.getenv("HOME") or ""
local tokenPath = home .. "/.config/puck/t3-token"
local runtimePath = home .. "/.t3/userdata/server-runtime.json"

-- Statuses T3 counts as an active run.
local ACTIVE = { queued = true, preparing = true, starting = true, running = true, waiting = true }
-- Finished runs that stay in the inbox until settled.
local FINISHED = { completed = true, failed = true, interrupted = true, cancelled = true }

local polls = 0
local inFlight = false

-- JSON nulls may decode to a sentinel; treat anything that isn't a string as absent.
local function present(v)
  return type(v) == "string" and v ~= ""
end

local function origin()
  local raw = noctalia.readFile(runtimePath)
  local runtime = raw and noctalia.json.decode(raw)
  if type(runtime) == "table" and present(runtime.origin) then
    return runtime.origin
  end
  return "http://127.0.0.1:3773"
end

local function projectNames(shell)
  local names = {}
  for _, p in ipairs(shell.projects or {}) do
    -- T3 files project-less threads under a placeholder project; show nothing for it.
    if p.title ~= "No project" then names[p.id] = p.title end
  end
  return names
end

-- Reduces T3's shell snapshot to what the bar shows. Pure; exported via state.
local function summarize(shell)
  local names = projectNames(shell)
  local s = { running = {}, waiting = {}, review = {}, failing = {}, prs = { open = 0, failing = 0, pending = 0 } }
  for _, t in ipairs(shell.threads or {}) do
    local topLevel = not (type(t.lineage) == "table" and present(t.lineage.parentThreadId))
    if topLevel and not present(t.archivedAt) and not present(t.deletedAt) then
      local item = { title = t.title or "Untitled", project = names[t.projectId] or "" }
      if type(t.pendingRuntimeRequest) == "table" then
        table.insert(s.waiting, item)
      elseif ACTIVE[t.status] then
        table.insert(s.running, item)
      elseif FINISHED[t.status] and not present(t.settledAt) and not present(t.snoozedAt) then
        table.insert(s.review, item)
      end
      for _, pr in ipairs(t.pullRequests or {}) do
        local snap = pr.snapshot
        if type(snap) == "table" and snap.state == "open" then
          s.prs.open += 1
          if snap.checksState == "failing" then
            s.prs.failing += 1
            table.insert(s.failing, { title = snap.title or ("#" .. tostring(pr.number)), project = pr.repository or "" })
          elseif snap.checksState == "pending" then
            s.prs.pending += 1
          end
        end
      end
    end
  end
  s.ok = true
  return s
end

local function pollThreads()
  if inFlight then return end
  local token = noctalia.readFile(tokenPath)
  if not token then
    noctalia.state.set("status", { ok = false, error = "No T3 token at ~/.config/puck/t3-token" })
    return
  end
  inFlight = true
  noctalia.http({
    url = origin() .. "/api/orchestration/shell?omitIdleSubagents=1&omitOlderSettled=1",
    method = "GET",
    headers = {
      "Authorization: Bearer " .. noctalia.string.trim(token),
      "x-t3-orchestration-protocol: 2",
      "Accept: application/json",
    },
  }, function(res)
    inFlight = false
    if not res or not res.ok or res.status ~= 200 then
      local status = res and res.status or 0
      noctalia.state.set("status", { ok = false, error = status == 401 and "T3 rejected the token" or "T3 is not reachable" })
      return
    end
    local shell = noctalia.json.decode(res.body)
    if type(shell) == "table" then
      noctalia.state.set("status", summarize(shell))
    end
  end)
end

local function pollSpend()
  noctalia.runAsync({ "puck", "spend" }, function(result)
    if not result or result.exitCode ~= 0 then return end
    local spend = noctalia.json.decode(result.stdout or "")
    if type(spend) == "table" and type(spend.usd) == "number" then
      noctalia.state.set("spend", spend.usd)
    end
  end)
end

noctalia.setUpdateInterval(POLL_MS)

function update()
  if polls % SPEND_EVERY == 0 then pollSpend() end
  polls += 1
  pollThreads()
end

-- `noctalia msg plugin axl47/puck:poller all refresh` forces an immediate poll.
function onIpc(event)
  if event == "refresh" then
    pollThreads()
    pollSpend()
  end
end

update()
