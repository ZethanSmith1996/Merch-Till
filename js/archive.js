import { dom } from "./dom.js";
import { supabaseConfig, currencyFormatter } from "./config.js";
import { getValidCloudAccessToken } from "./auth.js?v=step1e";
import { canManageArchive } from "./permissions.js";
import { escapeHTML } from "./utils.js";

const DEPARTMENT_KEY = "merch";

let productions = [];
let unassignedSessions = [];
let expandedProductionId = null;
let archiveRefreshTimer = null;


function setArchiveStatus(
    message,
    isError = false
) {
    if (!dom.archiveStatus) {
        return;
    }

    dom.archiveStatus.textContent =
        message;

    dom.archiveStatus.classList.toggle(
        "cloud-upload-error",
        isError
    );
}


async function archiveRequest(
    path,
    options = {}
) {
    if (!navigator.onLine) {
        throw new Error(
            "Archive requires an internet connection."
        );
    }

    const token =
        await getValidCloudAccessToken();

    if (!token) {
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
                        `Bearer ${token}`,
                    ...(options.headers || {})
                }
            }
        );

    if (!response.ok) {
        const details =
            await response.text();

        throw new Error(
            `Archive request failed (${response.status}). ${details}`
        );
    }

    return response;
}


function localDateValue(value) {
    if (!value) {
        return "";
    }

    return String(value)
        .slice(0, 10);
}


function displayDate(value) {
    if (!value) {
        return "—";
    }

    const date =
        new Date(
            `${localDateValue(value)}T12:00:00`
        );

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return value;
    }

    return new Intl.DateTimeFormat(
        "en-GB",
        {
            day: "2-digit",
            month: "short",
            year: "numeric"
        }
    ).format(date);
}


function statusLabel(status) {
    switch (status) {
        case "upcoming":
            return "Upcoming";

        case "active":
            return "Active";

        case "finished":
            return "Finished";

        default:
            return status || "Unknown";
    }
}


function closeDateDisplay(production) {
    /*
     * auto_close_date is exclusive, so the last selling day is the previous
     * calendar date. The UI says "Run" and displays the actual selling period.
     */
    if (!production.auto_close_date) {
        return "—";
    }

    const date =
        new Date(
            `${production.auto_close_date}T12:00:00`
        );

    date.setDate(
        date.getDate() - 1
    );

    return new Intl.DateTimeFormat(
        "en-GB",
        {
            day: "2-digit",
            month: "short",
            year: "numeric"
        }
    ).format(date);
}


function normaliseProduction(row) {
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
            row.start_date || "",
        autoCloseDate:
            row.auto_close_date || "",
        status:
            row.status || "finished",
        manuallyClosedAt:
            row.manually_closed_at ||
            null,
        sessionCount:
            Number(row.session_count) || 0,
        moneyTaken:
            Number(row.money_taken) || 0,
        productsSold:
            Number(row.products_sold) || 0,
        productCount:
            Number(row.product_count) || 0
    };
}


async function loadArchiveData({
    silent = false
} = {}) {
    if (!canManageArchive()) {
        return;
    }

    if (!navigator.onLine) {
        setArchiveStatus(
            "Archive is unavailable offline.",
            true
        );
        return;
    }

    if (!silent) {
        setArchiveStatus(
            "Loading Archive…"
        );
    }

    try {
        const [productionResponse, unassignedResponse] =
            await Promise.all([
                archiveRequest(
                    "rpc/get_archive_productions",
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
                ),

                archiveRequest(
                    "rpc/get_unassigned_sessions",
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
                )
            ]);

        productions =
            (await productionResponse.json())
                .map(normaliseProduction);

        unassignedSessions =
            await unassignedResponse.json();

        applyArchiveFilters();
        renderUnassignedBanner();

        if (!silent) {
            setArchiveStatus(
                "Archive is up to date."
            );
        }

    } catch (error) {
        console.error(
            "Archive could not be loaded:",
            error
        );

        setArchiveStatus(
            error instanceof Error
                ? error.message
                : String(error),
            true
        );
    }
}


function renderUnassignedBanner() {
    if (
        !dom.archiveUnassignedBanner ||
        !dom.archiveUnassignedCount
    ) {
        return;
    }

    const count =
        Array.isArray(unassignedSessions)
            ? unassignedSessions.length
            : 0;

    dom.archiveUnassignedBanner.hidden =
        count === 0;

    dom.archiveUnassignedCount.textContent =
        `${count} unassigned session${count === 1 ? "" : "s"}`;
}


function filteredProductions() {
    const from =
        dom.archiveFromDate?.value || "";

    const to =
        dom.archiveToDate?.value || "";

    const status =
        dom.archiveStatusFilter?.value || "";

    const search =
        (
            dom.archiveSearch?.value || ""
        )
            .trim()
            .toLowerCase();

    const sort =
        dom.archiveSortOrder?.value ||
        "newest";

    const result =
        productions.filter(
            function (production) {
                /*
                 * A Production overlaps the date filter when its run intersects
                 * the selected range.
                 */
                if (
                    from &&
                    production.autoCloseDate &&
                    production.autoCloseDate <=
                        from
                ) {
                    return false;
                }

                if (
                    to &&
                    production.startDate >
                        to
                ) {
                    return false;
                }

                if (
                    status &&
                    production.status !==
                        status
                ) {
                    return false;
                }

                if (search) {
                    const haystack =
                        [
                            production.name,
                            production.description,
                            production.status
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

    result.sort(
        function (first, second) {
            return (
                sort === "oldest"
                    ? first.startDate.localeCompare(
                        second.startDate
                    )
                    : second.startDate.localeCompare(
                        first.startDate
                    )
            );
        }
    );

    return result;
}


function applyArchiveFilters() {
    renderProductionList(
        filteredProductions()
    );
}


function renderProductionList(rows) {
    if (
        !dom.archiveProductionList ||
        !dom.archiveProductionCount
    ) {
        return;
    }

    dom.archiveProductionCount.textContent =
        `Displaying ${rows.length} production${rows.length === 1 ? "" : "s"}`;

    if (rows.length === 0) {
        dom.archiveProductionList.innerHTML =
            '<div class="archive-empty-message">No Productions match the selected filters.</div>';

        return;
    }

    dom.archiveProductionList.innerHTML =
        "";

    rows.forEach(
        function (production) {
            const card =
                document.createElement(
                    "article"
                );

            card.className =
                "archive-production-card";

            const expanded =
                String(
                    expandedProductionId
                ) ===
                String(production.id);

            const summary =
                document.createElement(
                    "button"
                );

            summary.type = "button";
            summary.className =
                "archive-production-summary";

            summary.setAttribute(
                "aria-expanded",
                String(expanded)
            );

            summary.innerHTML = `
                <span class="archive-production-name">
                    ${escapeHTML(production.name)}
                </span>

                <span class="archive-production-dates">
                    ${escapeHTML(displayDate(production.startDate))}
                    –
                    ${escapeHTML(closeDateDisplay(production))}
                </span>

                <span class="archive-status-badge ${escapeHTML(production.status)}">
                    ${escapeHTML(statusLabel(production.status))}
                </span>

                <span>
                    ${expanded ? "⌃" : "⌄"}
                </span>
            `;

            const details =
                document.createElement(
                    "div"
                );

            details.className =
                "archive-production-details";

            details.hidden =
                !expanded;

            const description =
                production.description
                    ? escapeHTML(
                        production.description
                    )
                    : "No description.";

            details.innerHTML = `
                <div class="archive-detail-grid">

                    <div class="archive-detail-stat">
                        <span>Sessions</span>
                        <strong>${production.sessionCount}</strong>
                    </div>

                    <div class="archive-detail-stat">
                        <span>Money Taken</span>
                        <strong>${currencyFormatter.format(production.moneyTaken)}</strong>
                    </div>

                    <div class="archive-detail-stat">
                        <span>Products Sold</span>
                        <strong>${production.productsSold}</strong>
                    </div>

                    <div class="archive-detail-stat">
                        <span>Products</span>
                        <strong>${production.productCount}</strong>
                    </div>

                </div>

                <p class="archive-production-description">
                    ${description}
                </p>

                <div
                    class="archive-production-actions"
                    data-production-actions="${production.id}"
                ></div>
            `;

            const actions =
                details.querySelector(
                    `[data-production-actions="${production.id}"]`
                );

            renderProductionActions(
                actions,
                production
            );

            summary.addEventListener(
                "click",
                function () {
                    expandedProductionId =
                        expanded
                            ? null
                            : production.id;

                    applyArchiveFilters();
                }
            );

            card.append(
                summary,
                details
            );

            dom.archiveProductionList
                .appendChild(card);
        }
    );
}


function actionButton(
    label,
    handler,
    {
        dangerous = false
    } = {}
) {
    const button =
        document.createElement(
            "button"
        );

    button.type = "button";
    button.className =
        "secondary-button archive-action-button";

    if (dangerous) {
        button.classList.add(
            "archive-danger-button"
        );
    }

    button.textContent =
        label;

    button.addEventListener(
        "click",
        handler
    );

    return button;
}


function renderProductionActions(
    container,
    production
) {
    if (!container) {
        return;
    }

    container.innerHTML = "";

    if (
        production.status ===
        "upcoming"
    ) {
        container.appendChild(
            actionButton(
                "Edit Production",
                function () {
                    openProductionModal(
                        production
                    );
                }
            )
        );
    }

    if (
        production.status ===
        "active"
    ) {
        container.appendChild(
            actionButton(
                "Close Production",
                function () {
                    finishProduction(
                        production
                    );
                }
            )
        );
    }

    if (
        production.status !==
            "finished" &&
        unassignedSessions.length > 0
    ) {
        container.appendChild(
            actionButton(
                `Assign Unassigned Sessions (${unassignedSessions.length})`,
                function () {
                    assignUnassignedSessions(
                        production
                    );
                }
            )
        );
    }

    if (
        production.status ===
            "upcoming" &&
        production.sessionCount === 0 &&
        production.productCount === 0
    ) {
        container.appendChild(
            actionButton(
                "Delete Empty Production",
                function () {
                    deleteProduction(
                        production
                    );
                },
                {
                    dangerous: true
                }
            )
        );
    }
}


function openProductionModal(
    production = null
) {
    if (!dom.productionModal) {
        return;
    }

    dom.productionForm.reset();
    dom.productionFormError.textContent =
        "";

    if (production) {
        dom.productionModalTitle.textContent =
            "Edit Production";

        dom.editingProductionId.value =
            production.id;

        dom.productionNameInput.value =
            production.name;

        dom.productionStartDateInput.value =
            production.startDate;

        dom.productionCloseDateInput.value =
            production.autoCloseDate;

        dom.productionDescriptionInput.value =
            production.description || "";
    } else {
        dom.productionModalTitle.textContent =
            "New Production";

        dom.editingProductionId.value =
            "";
    }

    dom.productionModal.hidden =
        false;

    window.setTimeout(
        function () {
            dom.productionNameInput.focus();
        },
        0
    );
}


function closeProductionModal() {
    if (!dom.productionModal) {
        return;
    }

    dom.productionModal.hidden =
        true;

    dom.productionForm.reset();
    dom.productionFormError.textContent =
        "";
    dom.editingProductionId.value =
        "";
}


async function saveProduction(event) {
    event.preventDefault();

    if (!canManageArchive()) {
        return;
    }

    const id =
        dom.editingProductionId.value
            ? Number(
                dom.editingProductionId.value
            )
            : null;

    const name =
        dom.productionNameInput.value
            .trim();

    const startDate =
        dom.productionStartDateInput.value;

    const autoCloseDate =
        dom.productionCloseDateInput.value;

    const description =
        dom.productionDescriptionInput.value
            .trim();

    if (!name) {
        dom.productionFormError.textContent =
            "Enter a Production name.";
        return;
    }

    if (
        !startDate ||
        !autoCloseDate
    ) {
        dom.productionFormError.textContent =
            "Choose the Start Date and Auto-close Date.";
        return;
    }

    if (
        autoCloseDate <=
        startDate
    ) {
        dom.productionFormError.textContent =
            "Auto-close Date must be after the Start Date.";
        return;
    }

    const submit =
        dom.productionForm.querySelector(
            'button[type="submit"]'
        );

    if (submit) {
        submit.disabled = true;
        submit.textContent =
            id
                ? "Saving…"
                : "Creating…";
    }

    try {
        await archiveRequest(
            id
                ? "rpc/update_production"
                : "rpc/create_production",
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/json",
                    "Accept":
                        "application/json"
                },
                body:
                    JSON.stringify(
                        id
                            ? {
                                p_production_id:
                                    id,
                                p_name:
                                    name,
                                p_start_date:
                                    startDate,
                                p_auto_close_date:
                                    autoCloseDate,
                                p_description:
                                    description || null
                            }
                            : {
                                p_name:
                                    name,
                                p_start_date:
                                    startDate,
                                p_auto_close_date:
                                    autoCloseDate,
                                p_description:
                                    description || null,
                                p_department_key:
                                    DEPARTMENT_KEY
                            }
                    )
            }
        );

        closeProductionModal();

        await loadArchiveData();

        document.dispatchEvent(
            new CustomEvent(
                "production-data-changed"
            )
        );

    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : String(error);

        if (
            message.includes(
                "PRODUCTION_DATES_OVERLAP"
            )
        ) {
            dom.productionFormError.textContent =
                "These dates overlap another Production.";
        } else {
            dom.productionFormError.textContent =
                message;
        }
    } finally {
        if (submit) {
            submit.disabled = false;
            submit.textContent =
                "Save Production";
        }
    }
}


async function finishProduction(
    production
) {
    const confirmed =
        window.confirm(
            `Close "${production.name}" now?\n\n` +
            "This will finish the Production immediately and automatically close any open session attached to it."
        );

    if (!confirmed) {
        return;
    }

    try {
        const response =
            await archiveRequest(
                "rpc/finish_production",
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
                            p_production_id:
                                production.id
                        })
                }
            );

        const result =
            await response.json();

        window.alert(
            `Production Closed — ${result.name || production.name}\n\n` +
            `Money Taken: ${currencyFormatter.format(Number(result.money_taken) || 0)}\n` +
            `Products Sold: ${Number(result.products_sold) || 0}`
        );

        await loadArchiveData();

        document.dispatchEvent(
            new CustomEvent(
                "production-data-changed"
            )
        );

    } catch (error) {
        window.alert(
            "The Production could not be closed.\n\n" +
            (
                error instanceof Error
                    ? error.message
                    : String(error)
            )
        );
    }
}


async function deleteProduction(
    production
) {
    const confirmed =
        window.confirm(
            `Delete empty Upcoming Production "${production.name}"?\n\n` +
            "This is only allowed because it contains no sessions, products or sales."
        );

    if (!confirmed) {
        return;
    }

    try {
        await archiveRequest(
            "rpc/delete_empty_production",
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
                        p_production_id:
                            production.id
                    })
            }
        );

        expandedProductionId =
            null;

        await loadArchiveData();

        document.dispatchEvent(
            new CustomEvent(
                "production-data-changed"
            )
        );

    } catch (error) {
        window.alert(
            "The Production could not be deleted.\n\n" +
            (
                error instanceof Error
                    ? error.message
                    : String(error)
            )
        );
    }
}


async function assignUnassignedSessions(
    production
) {
    if (
        unassignedSessions.length === 0
    ) {
        return;
    }

    const firstDate =
        unassignedSessions
            .map(function (session) {
                return localDateValue(
                    session.opened_at
                );
            })
            .sort()[0];

    const lastDate =
        unassignedSessions
            .map(function (session) {
                return localDateValue(
                    session.opened_at
                );
            })
            .sort()
            .at(-1);

    const confirmed =
        window.confirm(
            `Assign ${unassignedSessions.length} unassigned session${unassignedSessions.length === 1 ? "" : "s"} to "${production.name}"?\n\n` +
            `Session dates: ${displayDate(firstDate)} – ${displayDate(lastDate)}\n\n` +
            "All sales from those sessions will become part of this Production."
        );

    if (!confirmed) {
        return;
    }

    try {
        const response =
            await archiveRequest(
                "rpc/assign_unassigned_sessions_to_production",
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
                            p_production_id:
                                production.id
                        })
                }
            );

        const result =
            await response.json();

        window.alert(
            `${Number(result.sessions_assigned) || 0} session${Number(result.sessions_assigned) === 1 ? "" : "s"} assigned to "${production.name}".`
        );

        await loadArchiveData();

        document.dispatchEvent(
            new CustomEvent(
                "production-data-changed"
            )
        );

    } catch (error) {
        window.alert(
            "The unassigned sessions could not be attached.\n\n" +
            (
                error instanceof Error
                    ? error.message
                    : String(error)
            )
        );
    }
}


function resetFilters() {
    dom.archiveFromDate.value = "";
    dom.archiveToDate.value = "";
    dom.archiveStatusFilter.value = "";
    dom.archiveSearch.value = "";
    dom.archiveSortOrder.value =
        "newest";

    applyArchiveFilters();
}


function startArchiveRefresh() {
    stopArchiveRefresh();

    archiveRefreshTimer =
        window.setInterval(
            function () {
                if (
                    dom.archiveSection &&
                    !dom.archiveSection.hidden &&
                    navigator.onLine
                ) {
                    loadArchiveData({
                        silent: true
                    });
                }
            },
            15000
        );
}


function stopArchiveRefresh() {
    if (
        archiveRefreshTimer !==
        null
    ) {
        window.clearInterval(
            archiveRefreshTimer
        );

        archiveRefreshTimer =
            null;
    }
}


export function initialiseArchive() {
    dom.archiveNavButton
        ?.addEventListener(
            "click",
            function () {
                loadArchiveData();
                startArchiveRefresh();
            }
        );

    dom.addProductionButton
        ?.addEventListener(
            "click",
            function () {
                openProductionModal();
            }
        );

    dom.productionForm
        ?.addEventListener(
            "submit",
            saveProduction
        );

    dom.closeProductionModalButton
        ?.addEventListener(
            "click",
            closeProductionModal
        );

    dom.cancelProductionButton
        ?.addEventListener(
            "click",
            closeProductionModal
        );

    dom.productionModal
        ?.addEventListener(
            "click",
            function (event) {
                if (
                    event.target ===
                    dom.productionModal
                ) {
                    closeProductionModal();
                }
            }
        );

    [
        dom.archiveFromDate,
        dom.archiveToDate,
        dom.archiveStatusFilter,
        dom.archiveSortOrder
    ].forEach(
        function (element) {
            element?.addEventListener(
                "change",
                applyArchiveFilters
            );
        }
    );

    dom.archiveSearch
        ?.addEventListener(
            "input",
            applyArchiveFilters
        );

    dom.archiveResetFilters
        ?.addEventListener(
            "click",
            resetFilters
        );

    document
        .querySelectorAll(
            ".nav-button"
        )
        .forEach(
            function (button) {
                if (
                    button !==
                    dom.archiveNavButton
                ) {
                    button.addEventListener(
                        "click",
                        stopArchiveRefresh
                    );
                }
            }
        );

    window.addEventListener(
        "online",
        function () {
            if (
                dom.archiveSection &&
                !dom.archiveSection.hidden
            ) {
                loadArchiveData();
            }
        }
    );

    window.addEventListener(
        "offline",
        function () {
            if (
                dom.archiveSection &&
                !dom.archiveSection.hidden
            ) {
                setArchiveStatus(
                    "Archive is unavailable offline.",
                    true
                );
            }
        }
    );

    document.addEventListener(
        "production-data-changed",
        function () {
            if (
                dom.archiveSection &&
                !dom.archiveSection.hidden
            ) {
                loadArchiveData({
                    silent: true
                });
            }
        }
    );

    document.addEventListener(
        "keydown",
        function (event) {
            if (
                event.key === "Escape" &&
                dom.productionModal &&
                !dom.productionModal.hidden
            ) {
                closeProductionModal();
            }
        }
    );
}
