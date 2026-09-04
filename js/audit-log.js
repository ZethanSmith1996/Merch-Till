import { dom } from "./dom.js";
import { supabaseConfig } from "./config.js";
import { getValidCloudAccessToken } from "./auth.js?v=priority10b";
import { escapeHTML } from "./utils.js";

let auditEvents = [];
let auditUsers = [];

function currentRole() {
    return (
        sessionStorage.getItem(
            "merchTillRole"
        ) || ""
    );
}

function canViewAuditLog() {
    return [
        "admin",
        "master-admin"
    ].includes(
        currentRole()
    );
}

function setAuditStatus(
    message,
    isError = false
) {
    if (!dom.auditStatus) {
        return;
    }

    dom.auditStatus.textContent =
        message;

    dom.auditStatus.classList.toggle(
        "cloud-upload-error",
        isError
    );
}

async function auditCloudRequest(
    path,
    options = {}
) {
    if (!navigator.onLine) {
        throw new Error(
            "The Audit Log requires an internet connection."
        );
    }

    const accessToken =
        await getValidCloudAccessToken();

    if (!accessToken) {
        throw new Error(
            "No valid cloud session is available. Log out and log back in while online."
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
                        `Bearer ${accessToken}`,
                    ...(options.headers || {})
                }
            }
        );

    if (!response.ok) {
        const details =
            await response.text();

        throw new Error(
            `Audit request failed (${response.status}). ${details}`
        );
    }

    return response;
}

async function loadAuditUsers() {
    const response =
        await auditCloudRequest(
            "rpc/get_audit_filter_users",
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/json",
                    "Accept":
                        "application/json"
                },
                body: "{}"
            }
        );

    const rows =
        await response.json();

    auditUsers =
        Array.isArray(rows)
            ? rows
            : [];

    renderAuditUserOptions();
}

function renderAuditUserOptions() {
    if (!dom.auditUserFilter) {
        return;
    }

    const selected =
        dom.auditUserFilter.value;

    dom.auditUserFilter.innerHTML =
        '<option value="">All Users</option>';

    const activeUsers =
        auditUsers
            .filter(function (user) {
                return user.active === true;
            })
            .sort(function (a, b) {
                return a.username.localeCompare(
                    b.username
                );
            });

    const disabledUsers =
        auditUsers
            .filter(function (user) {
                return user.active !== true;
            })
            .sort(function (a, b) {
                return a.username.localeCompare(
                    b.username
                );
            });

    if (activeUsers.length > 0) {
        const group =
            document.createElement(
                "optgroup"
            );

        group.label =
            "Active Users";

        activeUsers.forEach(
            function (user) {
                const option =
                    document.createElement(
                        "option"
                    );

                option.value =
                    user.username;

                option.textContent =
                    user.username;

                group.appendChild(
                    option
                );
            }
        );

        dom.auditUserFilter.appendChild(
            group
        );
    }

    if (disabledUsers.length > 0) {
        const group =
            document.createElement(
                "optgroup"
            );

        group.label =
            "Disabled Users";

        disabledUsers.forEach(
            function (user) {
                const option =
                    document.createElement(
                        "option"
                    );

                option.value =
                    user.username;

                option.textContent =
                    user.username;

                group.appendChild(
                    option
                );
            }
        );

        dom.auditUserFilter.appendChild(
            group
        );
    }

    dom.auditUserFilter.value =
        selected;
}

async function loadAuditEvents() {
    if (!canViewAuditLog()) {
        return;
    }

    setAuditStatus(
        "Loading audit events…"
    );

    try {
        const response =
            await auditCloudRequest(
                "audit_log?select=id,created_at,user_id,username,action_category,message,details,department&order=created_at.desc&limit=5000",
                {
                    method: "GET",
                    headers: {
                        "Accept":
                            "application/json"
                    }
                }
            );

        const rows =
            await response.json();

        auditEvents =
            Array.isArray(rows)
                ? rows
                : [];

        await loadAuditUsers();

        applyAuditFilters();

        setAuditStatus(
            "Audit Log loaded successfully."
        );

    } catch (error) {
        console.error(
            "Audit Log could not be loaded:",
            error
        );

        auditEvents = [];
        renderAuditRows([]);

        setAuditStatus(
            error instanceof Error
                ? error.message
                : String(error),
            true
        );
    }
}

function formattedDateTime(value) {
    const date =
        new Date(value);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return {
            date: "",
            time: ""
        };
    }

    return {
        date:
            new Intl.DateTimeFormat(
                "en-GB",
                {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric"
                }
            ).format(date),

        time:
            new Intl.DateTimeFormat(
                "en-GB",
                {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    hour12: false
                }
            ).format(date)
    };
}

function localDateValue(value) {
    const date =
        new Date(value);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return "";
    }

    return [
        date.getFullYear(),
        String(
            date.getMonth() + 1
        ).padStart(2, "0"),
        String(
            date.getDate()
        ).padStart(2, "0")
    ].join("-");
}

function applyAuditFilters() {
    const from =
        dom.auditFromDate?.value || "";

    const to =
        dom.auditToDate?.value || "";

    const username =
        dom.auditUserFilter?.value || "";

    const action =
        dom.auditActionFilter?.value || "";

    const search =
        (
            dom.auditSearch?.value || ""
        )
            .trim()
            .toLowerCase();

    const sort =
        dom.auditSortOrder?.value ||
        "newest";

    const filtered =
        auditEvents.filter(
            function (event) {
                const eventDate =
                    localDateValue(
                        event.created_at
                    );

                if (
                    from &&
                    eventDate < from
                ) {
                    return false;
                }

                if (
                    to &&
                    eventDate > to
                ) {
                    return false;
                }

                if (
                    username &&
                    event.username !==
                        username
                ) {
                    return false;
                }

                if (
                    action &&
                    event.action_category !==
                        action
                ) {
                    return false;
                }

                if (search) {
                    const haystack =
                        [
                            event.username,
                            event.message,
                            JSON.stringify(
                                event.details || {}
                            )
                        ]
                            .join(" ")
                            .toLowerCase();

                    if (
                        !haystack.includes(
                            search
                        )
                    ) {
                        return false;
                    }
                }

                return true;
            }
        );

    filtered.sort(
        function (a, b) {
            const first =
                new Date(
                    a.created_at
                ).getTime();

            const second =
                new Date(
                    b.created_at
                ).getTime();

            return (
                sort === "oldest"
                    ? first - second
                    : second - first
            );
        }
    );

    renderAuditRows(filtered);
}

function renderAuditRows(events) {
    if (
        !dom.auditLogRows ||
        !dom.auditEventCount
    ) {
        return;
    }

    dom.auditEventCount.textContent =
        `Displaying ${events.length} event${events.length === 1 ? "" : "s"}`;

    if (events.length === 0) {
        dom.auditLogRows.innerHTML =
            '<div class="audit-empty-message">No audit events to display.</div>';

        return;
    }

    dom.auditLogRows.innerHTML =
        events.map(
            function (event) {
                const formatted =
                    formattedDateTime(
                        event.created_at
                    );

                return `
                    <div class="audit-log-row">

                        <span class="audit-log-date">
                            ${escapeHTML(formatted.date)}
                        </span>

                        <span class="audit-log-time">
                            ${escapeHTML(formatted.time)}
                        </span>

                        <span class="audit-log-message">
                            ${escapeHTML(event.message || "")}
                        </span>

                    </div>
                `;
            }
        ).join("");
}

function resetAuditFilters() {
    if (dom.auditFromDate) {
        dom.auditFromDate.value = "";
    }

    if (dom.auditToDate) {
        dom.auditToDate.value = "";
    }

    if (dom.auditUserFilter) {
        dom.auditUserFilter.value = "";
    }

    if (dom.auditActionFilter) {
        dom.auditActionFilter.value = "";
    }

    if (dom.auditSearch) {
        dom.auditSearch.value = "";
    }

    if (dom.auditSortOrder) {
        dom.auditSortOrder.value =
            "newest";
    }

    applyAuditFilters();
}


export async function logAuditEvent(
    actionCategory,
    message,
    details = {},
    eventKey = null,
    department = null
) {
    /*
     * Audit logging must never break the Till's primary operation.
     * The database RPC is append-only and derives the actor identity from the
     * authenticated Supabase session.
     */
    if (!navigator.onLine) {
        return false;
    }

    try {
        const response =
            await auditCloudRequest(
                "rpc/log_audit_event_once",
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json",
                        "Accept":
                            "application/json"
                    },
                    body: JSON.stringify({
                        p_action_category:
                            actionCategory,
                        p_message:
                            message,
                        p_details:
                            details || {},
                        p_department:
                            department,
                        p_event_key:
                            eventKey
                    })
                }
            );

        await response.text();

        document.dispatchEvent(
            new CustomEvent(
                "audit-log-updated"
            )
        );

        return true;

    } catch (error) {
        console.warn(
            "Audit event could not be recorded:",
            error
        );

        return false;
    }
}

function actorUsername() {
    return (
        sessionStorage.getItem(
            "merchTillUsername"
        ) || "Unknown"
    );
}

export function auditActorUsername() {
    return actorUsername();
}


export async function openAuditLog() {
    if (!canViewAuditLog()) {
        return;
    }

    if (!navigator.onLine) {
        setAuditStatus(
            "The Audit Log requires an internet connection.",
            true
        );

        renderAuditRows([]);
        return;
    }

    /*
     * Reload each time the tab opens so activity from another Till is visible.
     */
    await loadAuditEvents();
}

export function initialiseAuditLog() {
    const filters = [
        dom.auditFromDate,
        dom.auditToDate,
        dom.auditUserFilter,
        dom.auditActionFilter,
        dom.auditSortOrder
    ];

    filters.forEach(
        function (element) {
            if (!element) return;

            element.addEventListener(
                "change",
                applyAuditFilters
            );
        }
    );

    if (dom.auditSearch) {
        dom.auditSearch.addEventListener(
            "input",
            applyAuditFilters
        );
    }

    if (dom.auditResetFilters) {
        dom.auditResetFilters.addEventListener(
            "click",
            resetAuditFilters
        );
    }

    if (dom.auditNavButton) {
        dom.auditNavButton.addEventListener(
            "click",
            openAuditLog
        );
    }

    document.addEventListener(
        "audit-log-updated",
        function () {
            if (
                dom.auditSection &&
                !dom.auditSection.hidden &&
                navigator.onLine
            ) {
                loadAuditEvents();
            }
        }
    );

    window.addEventListener(
        "offline",
        function () {
            if (
                dom.auditSection &&
                !dom.auditSection.hidden
            ) {
                setAuditStatus(
                    "The Audit Log requires an internet connection.",
                    true
                );
            }
        }
    );

    window.addEventListener(
        "online",
        function () {
            if (
                dom.auditSection &&
                !dom.auditSection.hidden
            ) {
                openAuditLog();
            }
        }
    );
}
