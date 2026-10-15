const $ = (id) => document.getElementById(id);
const code = $("code");
const output = $("output");
const review = $("review");
const runState = $("runState");
const aiState = $("aiState");

$("sampleBtn").addEventListener("click", () => {
  code.value = 'def divide(a, b):\n    if b == 0:\n        raise ValueError("b must not be zero")\n    return a / b\n\nprint(divide(10, 2))\n';
});
$("clearBtn").addEventListener("click", () => { code.value = ""; output.textContent = "Editor cleared."; review.textContent = "Ready for a new review."; });

async function api(path, body) {
  const response = await fetch(path, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || `Request failed (${response.status})`);
  return data;
}
$("runBtn").addEventListener("click", async () => {
  runState.textContent = "Running…";
  output.textContent = "Sending execution request…";
  try {
    const data = await api("/execute/", {filename:"main.py", code:code.value});
    output.textContent = `stdout:\n${data.stdout || "(empty)"}\n\nstderr:\n${data.stderr || "(empty)"}\n\nexit code: ${data.exit_code}\nduration: ${data.duration_ms} ms`;
    runState.textContent = data.ok ? "Success" : "Completed with errors";
  } catch (error) {
    output.textContent = error.message;
    runState.textContent = "Unavailable";
  }
});
$("debugBtn").addEventListener("click", async () => {
  aiState.textContent = "Reviewing…";
  review.textContent = "Analyzing source…";
  try {
    const data = await api("/debug/", {filename:"main.py", language:"python", code:code.value, mode:$("mode").value});
    const lines = [];
    lines.push(data.analysis || data.error || "No summary returned.");
    if (data.issues?.length) lines.push("\nIssues:\n" + data.issues.map(x => `• ${x.type || x.severity || "Issue"}${x.line ? ` at line ${x.line}` : ""}: ${x.message || JSON.stringify(x)}`).join("\n"));
    if (data.suggestions?.length) lines.push("\nSuggestions:\n" + data.suggestions.map(x => "• " + (typeof x === "string" ? x : JSON.stringify(x))).join("\n"));
    if (data.fixed_code) lines.push("\nSuggested code:\n" + data.fixed_code);
    review.textContent = lines.join("\n");
    aiState.textContent = data.ai_available ? "AI review complete" : "Local / limited";
  } catch (error) {
    review.textContent = error.message;
    aiState.textContent = "Unavailable";
  }
});
code.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    $("runBtn").click();
  }
});
fetch("/health").then(r => r.json()).then(d => {
  $("apiStatus").innerHTML = `<i></i> API ${d.status}`;
}).catch(() => { $("apiStatus").textContent = "API unavailable"; });
