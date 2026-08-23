import { state } from './state.js';
import { dom } from './dom.js';
import { createSessionInDatabase, closeSessionInDatabase } from './database.js';
import { clearCart, refreshTillAvailability } from './till.js';
import { canManageSessions, isTrainingUser} from "./permissions.js";

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
        dom.sessionStatusText.textContent = `Session open — started ${formatTime(state.currentSession.openedAt)
        }`;

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

    if (state.currentSession) {
        return;
    }

    const now = new Date().toISOString();

    const session = {
        openedAt: now,
        closedAt: null,
        openedBy: username(),
        closedBy: null,
        status: "open"
    };

    try {
        const id =
            await createSessionInDatabase(session);

        state.currentSession = {
            ...session,
            id
        };

        state.sessions.unshift(
            state.currentSession
        );

        state.currentOrderNumber = 1;

        dom.orderNumberDisplay.textContent = "1";

        renderSessionStatus();

        document.dispatchEvent(
            new CustomEvent("sessions-changed")
        );

    } catch (error) {
        console.error(
            "Session could not be started:",
            error
        );

        window.alert(
            "The trading session could not be started."
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

    const sessionSales =
        state.sales.filter(function (sale) {
            return (
                String(sale.sessionId) === String(state.currentSession.id) &&
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

    if (!shouldCashOff) {
        return;
    }

    const closedAt =
        new Date().toISOString();

    const closedSession = {
        ...state.currentSession,
        closedAt: closedAt,
        closedBy: username(),
        status: "closed"
    };

    try {
        await closeSessionInDatabase(
            closedSession
        );

        const index =
            state.sessions.findIndex(
                function (session) {
                    return (
                        session.id ===
                        closedSession.id
                    );
                }
            );

        if (index >= 0) {
            state.sessions[index] =
                closedSession;
        }

        state.currentSession = null;

        clearCart();
        renderSessionStatus();

        document.dispatchEvent(
            new CustomEvent("sessions-changed")
        );

    } catch (error) {
        console.error(
            "Session could not be cashed off:",
            error
        );

        window.alert(
            "The session could not be cashed off."
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
    dom.startSessionButton.addEventListener('click', startSession);
    dom.cashOffSessionButton.addEventListener('click', cashOffSession);
    renderSessionStatus();
}
