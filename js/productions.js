import { dom } from "./dom.js";
import { state } from "./state.js";
import { supabaseConfig } from "./config.js";
import { getValidCloudAccessToken } from "./auth.js?v=step1e";

const DEPARTMENT_KEY = "merch";
const LIFECYCLE_REFRESH_MS = 60 * 1000;

let lifecycleTimer = null;
let lifecycleRequestInProgress = false;


async function productionCloudRequest(
    path,
    options = {}
) {
    if (!navigator.onLine) {
        throw new Error(
            "Current Production cannot be refreshed while offline."
        );
    }

    const token =
        await getValidCloudAccessToken();

    if (!token) {
        throw new Error(
            "No valid cloud session is available."
        );
    }

    const response =
        await fetch(
            `${supabaseConfig.url}/rest/v1/${path}`,
            {
                ...options,
                headers: {
                    "apikey":
                        supabaseConfig.publishableKey,
                    "Authorization":
                        `Bearer ${token}`,
                    ...(options.headers || {})
                }
            }
        );

    if (!response.ok) {
        const details =
            await response.text();

        throw new Error(
            `Production request failed (${response.status}). ${details}`
        );
    }

    return response;
}


function normaliseProduction(row) {
    if (!row) {
        return null;
    }

    return {
        id: Number(row.id),
        departmentKey:
            row.department_key ||
            DEPARTMENT_KEY,
        name:
            row.name || "",
        description:
            row.description || "",
        startDate:
            row.start_date || null,
        autoCloseDate:
            row.auto_close_date || null,
        status:
            row.status || "active"
    };
}


export function renderCurrentProduction() {
    if (
        !dom.productionStatusPill ||
        !dom.productionStatusLabel
    ) {
        return;
    }

    dom.productionStatusPill.classList.remove(
        "production-active",
        "no-production",
        "production-checking"
    );

    if (state.currentProduction) {
        dom.productionStatusPill.classList.add(
            "production-active"
        );

        dom.productionStatusLabel.textContent =
            state.currentProduction.name;

        dom.productionStatusPill.title =
            `Current production: ${state.currentProduction.name}`;
    } else {
        dom.productionStatusPill.classList.add(
            "no-production"
        );

        dom.productionStatusLabel.textContent =
            "No Production";

        dom.productionStatusPill.title =
            "No production is currently active";
    }
}


function renderChecking() {
    if (
        !dom.productionStatusPill ||
        !dom.productionStatusLabel
    ) {
        return;
    }

    dom.productionStatusPill.classList.remove(
        "production-active",
        "no-production"
    );

    dom.productionStatusPill.classList.add(
        "production-checking"
    );

    dom.productionStatusLabel.textContent =
        "Checking Production…";
}


export async function refreshCurrentProduction({
    silent = false
} = {}) {
    if (lifecycleRequestInProgress) {
        return state.currentProduction;
    }

    if (!navigator.onLine) {
        renderCurrentProduction();
        return state.currentProduction;
    }

    lifecycleRequestInProgress = true;

    if (!silent) {
        renderChecking();
    }

    try {
        const response =
            await productionCloudRequest(
                "rpc/sync_production_lifecycle",
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
                            p_department_key:
                                DEPARTMENT_KEY
                        })
                }
            );

        const result =
            await response.json();

        state.currentProduction =
            normaliseProduction(
                result?.current_production ||
                null
            );

        renderCurrentProduction();

        document.dispatchEvent(
            new CustomEvent(
                "production-changed",
                {
                    detail: {
                        production:
                            state.currentProduction,
                        autoClosedSessionIds:
                            Array.isArray(
                                result
                                    ?.auto_closed_session_ids
                            )
                                ? result
                                    .auto_closed_session_ids
                                : []
                    }
                }
            )
        );

        return state.currentProduction;

    } catch (error) {
        console.warn(
            "Current Production could not be refreshed:",
            error
        );

        /*
         * Keep the last known production visible. The cloud indicator already
         * tells the operator if the device is offline or has a sync problem.
         */
        renderCurrentProduction();

        return state.currentProduction;

    } finally {
        lifecycleRequestInProgress =
            false;
    }
}


function startLifecycleTimer() {
    stopLifecycleTimer();

    lifecycleTimer =
        window.setInterval(
            function () {
                if (
                    navigator.onLine &&
                    document.visibilityState !==
                        "hidden"
                ) {
                    refreshCurrentProduction({
                        silent: true
                    });
                }
            },
            LIFECYCLE_REFRESH_MS
        );
}


function stopLifecycleTimer() {
    if (lifecycleTimer !== null) {
        window.clearInterval(
            lifecycleTimer
        );

        lifecycleTimer = null;
    }
}


export function initialiseProductions() {
    renderCurrentProduction();
    startLifecycleTimer();

    window.addEventListener(
        "online",
        function () {
            refreshCurrentProduction();
        }
    );

    document.addEventListener(
        "visibilitychange",
        function () {
            if (
                document.visibilityState ===
                    "visible" &&
                navigator.onLine
            ) {
                refreshCurrentProduction({
                    silent: true
                });
            }
        }
    );

    document.addEventListener(
        "production-data-changed",
        function () {
            refreshCurrentProduction({
                silent: true
            });
        }
    );

    window.addEventListener(
        "pagehide",
        stopLifecycleTimer
    );
}
