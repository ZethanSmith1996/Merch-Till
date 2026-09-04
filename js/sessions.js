import { state } from './state.js';
import { dom } from './dom.js';
import { replaceSessionCacheInDatabase } from "./database.js?v=step3c";
import { clearCart, refreshTillAvailability } from './till.js';
import { canManageSessions, isTrainingUser } from "./permissions.js";
import { getValidCloudAccessToken } from "./auth.js?v=step3c";
import { supabaseConfig, currencyFormatter } from "./config.js?v=step3c";
import { logAuditEvent, auditActorUsername } from "./audit-log.js?v=priority10c";


function setSessionCloudStatus(message, isError = false) {
    const status = document.getElementById("session-cloud-status");
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("cloud-upload-error", isError);
}

async function sessionCloudRequest(path, options = {}) {
    if (!navigator.onLine) {
        throw new Error(
            "Trading-session management requires an internet connection."
        );
    }

    const accessToken = await getValidCloudAccessToken();

    if (!accessToken) {
        throw new Error(
            "No valid cloud session is available. Log out and log back in while online."
        );
    }

    const response = await fetch(
        `${supabaseConfig.url}/rest/v1/${path}`,
        {
            ...options,
            headers: {
                "apikey": supabaseConfig.publishableKey,
                "Authorization": `Bearer ${accessToken}`,
                ...(options.headers || {})
            }
        }
    );

    if (!response.ok) {
        const details = await response.text();
        throw new Error(
            `Cloud session request failed (${response.status}). ${details}`
        );
    }

    return response;
}

function mapSessionForCloud(session) {
    return {
        id: session.id,
        opened_at: session.openedAt,
        closed_at: session.closedAt || null,
        opened_by: session.openedBy || null,
        closed_by: session.closedBy || null,
        status: session.status || (session.closedAt ? "closed" : "open"),
        production_id:
            session.productionId ?? null,
        cloud_updated_at: new Date().toISOString()
    };
}

function unmapCloudSession(row) {
    return {
        id: Number(row.id),
        openedAt: row.opened_at,
        closedAt: row.closed_at || null,
        openedBy: row.opened_by || null,
        closedBy: row.closed_by || null,
        status: row.status || (row.closed_at ? "closed" : "open"),
        productionId:
            row.production_id === null ||
            row.production_id === undefined
                ? null
                : Number(row.production_id)
    };
}

function createUniqueSessionId() {
    return (
        Date.now() * 1000 +
        Math.floor(Math.random() * 1000)
    );
}

async function fetchAuthoritativeCloudSessions() {
    const response = await sessionCloudRequest(
        "sessions?select=*&order=opened_at.desc",
        {
            method: "GET",
            headers: { "Accept": "application/json" }
        }
    );

    const rows = await response.json();

    return rows.map(unmapCloudSession).sort(function (first, second) {
        return second.openedAt.localeCompare(first.openedAt);
    });
}

async function refreshSessionCacheFromCloud() {
    const sessions = await fetchAuthoritativeCloudSessions();

    await replaceSessionCacheInDatabase(sessions);

    state.sessions = sessions;
    state.currentSession =
        sessions.find(function (session) {
            return session.status === "open";
        }) || null;

    document.dispatchEvent(
        new CustomEvent("sessions-changed", {
            detail: { cloudConfirmed: true }
        })
    );

    setSessionCloudStatus(
        "Trading sessions are synced with Supabase."
    );

    renderSessionStatus();
    return sessions;
}

function requireOnlineSessionManagement() {
    if (navigator.onLine) return true;

    setSessionCloudStatus(
        "Session management is unavailable offline. An already-open session can continue selling from the cached session.",
        true
    );

    window.alert(
        "Starting or cashing off a trading session requires an internet connection.\n\n" +
        "If a session was already open before connection was lost, sales can continue using the cached session."
    );

    return false;
}

function updateSessionManagementAvailability() {
    const offline = !navigator.onLine;

    if (dom.startSessionButton) {
        dom.startSessionButton.disabled =
            canManageSessions() && offline;
    }

    if (dom.cashOffSessionButton) {
        dom.cashOffSessionButton.disabled =
            canManageSessions() && offline;
    }

    if (offline) {
        setSessionCloudStatus(
            "Session management is unavailable offline. An already-open session can continue selling from the cached session.",
            true
        );
    } else {
        setSessionCloudStatus(
            "Session management is online. Supabase is the source of truth."
        );
    }

    renderSessionStatus();
}


function username() {
    return sessionStorage.getItem('merchTillUsername') || 'Unknown';
}

function formatTime(iso) {
    if (!iso) return 'Open';
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function renderSessionStatus() {
    const sessionOpen = Boolean(state.currentSession);
    const mayManageSessions = canManageSessions();
    const trainingMode = isTrainingUser();

    /*
    * Training mode
     */

    if (trainingMode) {
        dom.tradingStatusPill.classList.remove("trading-open","trading-closed");
        dom.tradingStatusPill.classList.add("training-mode");
        dom.tradingStatusLabel.textContent = "Training Mode";
        dom.sessionStatusText.textContent = "Training mode — no trading session is required.";
        dom.startSessionButton.hidden = true;
        dom.cashOffSessionButton.hidden = true;

        /*
         * The existing Training banner remains visible,
         * so the ordinary session bar is unnecessary.
         */
        dom.sessionControlBar.hidden = true; refreshTillAvailability();
        return;
    }


    /*
     * Remove the Training appearance when another
     * account logs in.
     */

    dom.tradingStatusPill.classList.remove("training-mode");


    /*
     * Open trading session
     */

    if (sessionOpen) {
        dom.tradingStatusPill.classList.remove("trading-closed");
        dom.tradingStatusPill.classList.add("trading-open");
        dom.tradingStatusLabel.textContent = "Trading Open";
        const productionText =
            state.currentSession.productionId
                ? (
                    state.currentProduction &&
                    String(state.currentProduction.id) ===
                        String(state.currentSession.productionId)
                        ? ` · ${state.currentProduction.name}`
                        : " · Assigned Production"
                )
                : " · Unassigned";

        dom.sessionStatusText.textContent =
            `Session open — started ${formatTime(state.currentSession.openedAt)}${productionText}`;

        /*
         * Admin and Master Admin need the session bar
         * because it contains the Cash Off button.
         *
         * Staff only need the green header pill.
         */
        dom.sessionControlBar.hidden = !mayManageSessions;
        dom.startSessionButton.hidden = true;
        dom.cashOffSessionButton.hidden = !mayManageSessions;

        refreshTillAvailability();

        return;
    }


    /*
     * Trading closed
     */

    dom.tradingStatusPill.classList.remove(
        "trading-open"
    );

    dom.tradingStatusPill.classList.add(
        "trading-closed"
    );

    dom.tradingStatusLabel.textContent =
        "Trading Closed";

    dom.sessionStatusText.textContent =
        mayManageSessions
            ? "Trading closed — start a session to begin selling."
            : "Trading closed — an administrator must start a session before selling.";

    /*
     * Keep the explanatory bar visible when trading
     * is closed, including for Staff users.
     */
    dom.sessionControlBar.hidden = false;

    dom.startSessionButton.hidden =
        !mayManageSessions;

    dom.cashOffSessionButton.hidden = true;

    refreshTillAvailability();
}

async function startSession() {
    if (!canManageSessions()) {
        window.alert(
            "Only an administrator can start a trading session."
        );
        return;
    }

    if (!requireOnlineSessionManagement()) {
        return;
    }

    try {
        const authoritativeSessions =
            await fetchAuthoritativeCloudSessions();

        const existingOpenSession =
            authoritativeSessions.find(function (session) {
                return session.status === "open";
            });

        if (existingOpenSession) {
            await replaceSessionCacheInDatabase(authoritativeSessions);
            state.sessions = authoritativeSessions;
            state.currentSession = existingOpenSession;
            renderSessionStatus();

            window.alert(
                "A trading session is already open in Supabase."
            );
            return;
        }

        const requestedSessionId =
            createUniqueSessionId();

        setSessionCloudStatus(
            "Starting trading session in Supabase…"
        );

        const response =
            await sessionCloudRequest(
                "rpc/start_trading_session",
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json",
                        "Accept":
                            "application/json"
                    },
                    body:
                        JSON.stringify({
                            p_session_id:
                                requestedSessionId,
                            p_department_key:
                                "merch"
                        })
                }
            );

        const result =
            await response.json();

        const sessionId =
            Number(
                result?.session_id ||
                requestedSessionId
            );

        state.currentOrderNumber = 1;
        dom.orderNumberDisplay.textContent = "1";

        await logAuditEvent(
            "trading_session",
            result?.production_name
                ? `${auditActorUsername()} opened trading session for production "${result.production_name}".`
                : `${auditActorUsername()} opened unassigned trading session — no production was active.`,
            {
                session_id:
                    sessionId,
                production_id:
                    result?.production_id ??
                    null,
                production_name:
                    result?.production_name ??
                    null
            },
            `session-open:${sessionId}`
        );

        await refreshSessionCacheFromCloud();

        document.dispatchEvent(
            new CustomEvent(
                "production-refresh-requested"
            )
        );

    } catch (error) {
        console.error("Session could not be started:", error);

        setSessionCloudStatus(
            `Session start failed: ${error.message || error}`,
            true
        );

        window.alert(
            "The trading session could not be started.\n\n" +
            (error.message || error)
        );
    }
}

async function cashOffSession() {
    if (!canManageSessions()) {
        window.alert(
            "Only an administrator can cash off a trading session."
        );
        return;
    }

    if (!state.currentSession) {
        return;
    }

    if (!requireOnlineSessionManagement()) {
        return;
    }

    const sessionSales =
        state.sales.filter(function (sale) {
            return (
                String(sale.sessionId) ===
                    String(state.currentSession.id) &&
                !sale.voided
            );
        });

    const revenue =
        sessionSales.reduce(function (sum, sale) {
            return sum + sale.total;
        }, 0);

    const items =
        sessionSales.reduce(function (sum, sale) {
            return sum + sale.itemCount;
        }, 0);

    const shouldCashOff =
        window.confirm(
            "Cash off current session?\n\n" +
            `Revenue: £${revenue.toFixed(2)}\n` +
            `Items sold: ${items}\n` +
            `Transactions: ${sessionSales.length}\n\n` +
            "Products and stock will not reset."
        );

    if (!shouldCashOff) return;

    try {
        const authoritativeSessions =
            await fetchAuthoritativeCloudSessions();

        const cloudSession =
            authoritativeSessions.find(function (session) {
                return (
                    String(session.id) ===
                    String(state.currentSession.id)
                );
            });

        if (!cloudSession) {
            throw new Error(
                "The current session could not be found in Supabase."
            );
        }

        if (cloudSession.status !== "open") {
            await replaceSessionCacheInDatabase(authoritativeSessions);
            state.sessions = authoritativeSessions;
            state.currentSession =
                authoritativeSessions.find(function (session) {
                    return session.status === "open";
                }) || null;

            clearCart();
            renderSessionStatus();

            window.alert(
                "This trading session had already been closed on another device."
            );
            return;
        }

        setSessionCloudStatus(
            "Cashing off trading session in Supabase…"
        );

        await sessionCloudRequest(
            `sessions?id=eq.${encodeURIComponent(cloudSession.id)}`,
            {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    "Prefer": "return=minimal"
                },
                body: JSON.stringify({
                    closed_at: new Date().toISOString(),
                    closed_by: username(),
                    status: "closed",
                    cloud_updated_at: new Date().toISOString()
                })
            }
        );

        await logAuditEvent(
            "trading_session",
            `${auditActorUsername()} cashed off trading session. Revenue ${currencyFormatter.format(revenue)}; ${items} item${items === 1 ? "" : "s"} sold; ${sessionSales.length} transaction${sessionSales.length === 1 ? "" : "s"}.`,
            {
                session_id:
                    cloudSession.id,
                revenue,
                items,
                transactions:
                    sessionSales.length
            },
            `session-close:${cloudSession.id}`
        );

        clearCart();
        await refreshSessionCacheFromCloud();

    } catch (error) {
        console.error("Session could not be cashed off:", error);

        setSessionCloudStatus(
            `Cash off failed: ${error.message || error}`,
            true
        );

        window.alert(
            "The session could not be cashed off.\n\n" +
            (error.message || error)
        );
    }
}

export function restoreCurrentOrderNumber() {
    if (!state.currentSession) {
        state.currentOrderNumber = 1;
        dom.orderNumberDisplay.textContent = "1";
        return;
    }

    const sessionOrderNumbers = state.sales
        .filter(function (sale) {
            return String(sale.sessionId) === String(state.currentSession.id);
        })
        .map(function (sale) {
            return Number(sale.orderNumber) || 0;
        });

    const highestOrderNumber = sessionOrderNumbers.length > 0
        ? Math.max(...sessionOrderNumbers)
        : 0;

    state.currentOrderNumber = highestOrderNumber + 1;
    dom.orderNumberDisplay.textContent = String(state.currentOrderNumber);
}

export function initialiseSessions() {
    dom.startSessionButton.addEventListener(
        "click",
        startSession
    );

    dom.cashOffSessionButton.addEventListener(
        "click",
        cashOffSession
    );

    window.addEventListener(
        "online",
        updateSessionManagementAvailability
    );

    window.addEventListener(
        "offline",
        updateSessionManagementAvailability
    );

    document.addEventListener(
        "cloud-data-loaded",
        updateSessionManagementAvailability
    );

    document.addEventListener(
        "production-changed",
        renderSessionStatus
    );

    updateSessionManagementAvailability();
}
