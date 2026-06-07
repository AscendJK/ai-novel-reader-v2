/** Get Authorization headers for authenticated API calls */
export function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("sync-token");
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}
