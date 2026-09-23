-- Runs each cell ardour_host.py writes to a file, in Ardour's Lua session.
-- A cell's value and outcome follow markers the host reads up to, and an
-- error is reported rather than ending the session.
function __bayma_cell(path)
  local file = assert(io.open(path))
  local code = file:read("a")
  file:close()
  -- A cell that is an expression returns it, as Lua's own REPL does.
  local chunk, problem = load("return " .. code, "=cell")
  if not chunk then chunk, problem = load(code, "=cell") end
  local ok, result
  if chunk then ok, result = xpcall(chunk, debug.traceback) else ok, result = false, problem end
  if ok and result ~= nil then
    io.stdout:write("\1BAYMA-VALUE-BEGIN\n", tostring(result), "\n\1BAYMA-VALUE-END\n")
  end
  io.stdout:write("\1BAYMA-END " .. (ok and "ok" or "error") .. "\n")
  if not ok then io.stdout:write(tostring(result), "\n\1BAYMA-ERROR-END\n") end
  io.stdout:flush()
end
