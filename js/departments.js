import { dom } from "./dom.js";
import { supabaseConfig } from "./config.js";
import { getValidCloudAccessToken } from "./auth.js?v=step1e";
import { canManageDepartments } from "./permissions.js?v=stage15b";
import {
    isDepartmentAvailableOnDevice,
    setDepartmentAvailableOnDevice,
    setCurrentDepartment
} from "./department-context.js?v=stage15f2";
import { showScreen } from "./navigation.js?v=stage15f2";
import { escapeHTML } from "./utils.js";

let departments = [];
let refreshInProgress = false;

function setStatus(message, isError = false) {
    if (!dom.departmentsStatus) return;

    dom.departmentsStatus.textContent = message;
    dom.departmentsStatus.classList.toggle(
        "cloud-upload-error",
        isError
    );
}

async function departmentRequest(path, options = {}) {
    if (!navigator.onLine) {
        throw new Error("Departments requires an internet connection.");
    }

    const token = await getValidCloudAccessToken();

    if (!token) {
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
                "Authorization": `Bearer ${token}`,
                ...(options.headers || {})
            }
        }
    );

    if (!response.ok) {
        const details = await response.text();
        throw new Error(
            `Department request failed (${response.status}). ${details}`
        );
    }

    return response;
}

function normaliseDepartment(row) {
    return {
        id: Number(row.id),
        key: row.department_key || "",
        name: row.name || "Department",
        active: row.active === true,
        isMerchandise: row.is_merchandise === true,
        badgeColor:
            row.badge_color || "default"
    };
}

function departmentCard(department) {
    const card = document.createElement("article");
    card.className = "department-card";

    card.innerHTML = `
        <div class="department-card-copy">
            <div class="department-card-title-row">
                <h4>${escapeHTML(department.name)}</h4>

                <span class="department-status-badge ${department.active ? "active" : "disabled"}">
                    ${department.active ? "Active" : "Disabled"}
                </span>
            </div>

            <div class="department-card-meta">
                ${
                    department.isMerchandise
                        ? '<span class="department-built-in">Built-in Department</span>'
                        : ""
                }

                <span>Key: ${escapeHTML(department.key)}</span>
            </div>
        </div>

        <div class="department-card-actions">

            <label class="department-badge-colour-control">
                <span>Badge Colour</span>

                <select class="department-badge-colour-select">
                    <option value="default" ${department.badgeColor === "default" ? "selected" : ""}>Default</option>
                    <option value="blue" ${department.badgeColor === "blue" ? "selected" : ""}>Blue</option>
                    <option value="green" ${department.badgeColor === "green" ? "selected" : ""}>Green</option>
                    <option value="pink" ${department.badgeColor === "pink" ? "selected" : ""}>Pink</option>
                    <option value="purple" ${department.badgeColor === "purple" ? "selected" : ""}>Purple</option>
                    <option value="orange" ${department.badgeColor === "orange" ? "selected" : ""}>Orange</option>
                    <option value="yellow" ${department.badgeColor === "yellow" ? "selected" : ""}>Yellow</option>
                </select>
            </label>

            <label class="department-device-availability">
                <span>
                    Available on this Device
                </span>

                <span class="option-switch">
                    <input
                        type="checkbox"
                        class="department-device-availability-input"
                        ${isDepartmentAvailableOnDevice(department.id) ? "checked" : ""}
                        ${department.active ? "" : "disabled"}
                    >

                    <span
                        class="option-switch-track"
                        aria-hidden="true"
                    >
                        <span class="option-switch-thumb"></span>
                    </span>

                    <span class="option-switch-label">
                        ${isDepartmentAvailableOnDevice(department.id) ? "On" : "Off"}
                    </span>
                </span>
            </label>

            <button
                type="button"
                class="secondary-button department-manage-button"
            >
                Manage
            </button>

            ${
                department.isMerchandise
                    ? '<button type="button" class="secondary-button department-permanent-button" disabled>Permanent</button>'
                    : department.active
                        ? '<button type="button" class="secondary-button department-disable-button">Disable</button>'
                        : '<button type="button" class="secondary-button department-enable-button">Re-enable</button>'
            }
        </div>
    `;

    const badgeColourSelect =
        card.querySelector(
            ".department-badge-colour-select"
        );

    badgeColourSelect
        ?.addEventListener(
            "change",
            async function () {
                const previous =
                    department.badgeColor;

                badgeColourSelect.disabled =
                    true;

                try {
                    await departmentRequest(
                        "rpc/set_department_badge_color",
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
                                    p_department_id:
                                        department.id,
                                    p_badge_color:
                                        badgeColourSelect.value
                                })
                        }
                    );

                    department.badgeColor =
                        badgeColourSelect.value;

                    document.dispatchEvent(
                        new CustomEvent(
                            "department-badge-color-changed",
                            {
                                detail: {
                                    departmentId:
                                        department.id,
                                    badgeColor:
                                        department.badgeColor
                                }
                            }
                        )
                    );

                    await loadDepartments({
                        silent: true
                    });

                    document.dispatchEvent(
                        new CustomEvent(
                            "departments-changed"
                        )
                    );

                } catch (error) {
                    badgeColourSelect.value =
                        previous;

                    window.alert(
                        "The Department badge colour could not be changed.\n\n" +
                        (
                            error instanceof Error
                                ? error.message
                                : String(error)
                        )
                    );

                } finally {
                    badgeColourSelect.disabled =
                        false;
                }
            }
        );


    const availabilityInput =
        card.querySelector(
            ".department-device-availability-input"
        );

    availabilityInput
        ?.addEventListener(
            "change",
            function () {
                setDepartmentAvailableOnDevice(
                    department.id,
                    availabilityInput.checked
                );

                const label =
                    card.querySelector(
                        ".department-device-availability .option-switch-label"
                    );

                if (label) {
                    label.textContent =
                        availabilityInput.checked
                            ? "On"
                            : "Off";
                }
            }
        );

    card.querySelector(
        ".department-manage-button"
    )
        ?.addEventListener(
            "click",
            function () {
                /*
                 * Management is deliberately allowed even if the Department
                 * is disabled. This does not make it operationally selectable.
                 */
                setCurrentDepartment(
                    department
                );

                showScreen(
                    "products-section"
                );
            }
        );


    card.querySelector(".department-disable-button")
        ?.addEventListener("click", function () {
            disableDepartment(department);
        });

    card.querySelector(".department-enable-button")
        ?.addEventListener("click", function () {
            enableDepartment(department);
        });

    return card;
}

function renderDepartments() {
    const active = departments.filter(d => d.active);
    const disabled = departments.filter(d => !d.active);

    dom.activeDepartmentsList.innerHTML = "";
    dom.disabledDepartmentsList.innerHTML = "";

    active.forEach(d => dom.activeDepartmentsList.appendChild(departmentCard(d)));
    disabled.forEach(d => dom.disabledDepartmentsList.appendChild(departmentCard(d)));

    dom.activeDepartmentsCount.textContent = String(active.length);
    dom.disabledDepartmentsCount.textContent = String(disabled.length);

    dom.noActiveDepartmentsMessage.hidden = active.length > 0;
    dom.noDisabledDepartmentsMessage.hidden = disabled.length > 0;
}

export async function loadDepartments({ silent = false } = {}) {
    if (!canManageDepartments() || refreshInProgress) return;

    if (!navigator.onLine) {
        setStatus("Departments is unavailable offline.", true);
        return;
    }

    refreshInProgress = true;
    if (!silent) setStatus("Loading Departments…");

    try {
        const response = await departmentRequest(
            "rpc/get_departments",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                body: JSON.stringify({
                    p_include_disabled: true
                })
            }
        );

        const rows = await response.json();
        departments = Array.isArray(rows)
            ? rows.map(normaliseDepartment)
            : [];

        renderDepartments();
        setStatus(
            `${departments.length} Department${departments.length === 1 ? "" : "s"} configured.`
        );
    } catch (error) {
        setStatus(
            error instanceof Error ? error.message : String(error),
            true
        );
    } finally {
        refreshInProgress = false;
    }
}

function openDepartmentModal() {
    if (!canManageDepartments()) return;

    dom.departmentForm.reset();
    dom.departmentFormError.textContent = "";
    dom.departmentModal.hidden = false;

    window.setTimeout(function () {
        dom.departmentNameInput.focus();
    }, 0);
}

function closeDepartmentModal() {
    dom.departmentModal.hidden = true;
    dom.departmentForm.reset();
    dom.departmentFormError.textContent = "";
}

async function createDepartment(event) {
    event.preventDefault();

    const name = dom.departmentNameInput.value.trim();

    if (!name) {
        dom.departmentFormError.textContent = "Enter a Department name.";
        return;
    }

    const submit = dom.departmentForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    submit.textContent = "Creating…";

    try {
        await departmentRequest(
            "rpc/create_department",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                body: JSON.stringify({ p_name: name })
            }
        );

        closeDepartmentModal();
        await loadDepartments();
        document.dispatchEvent(new CustomEvent("departments-changed"));
        document.dispatchEvent(new CustomEvent("audit-log-updated"));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        dom.departmentFormError.textContent =
            message.includes("DEPARTMENT_ALREADY_EXISTS")
                ? "A Department with this name already exists."
                : message;
    } finally {
        submit.disabled = false;
        submit.textContent = "Create Department";
    }
}

async function setDepartmentActive(department, active) {
    const response = await departmentRequest(
        "rpc/set_department_active",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify({
                p_department_id: department.id,
                p_active: active
            })
        }
    );

    await response.json().catch(function () {});
    await loadDepartments();

    document.dispatchEvent(new CustomEvent("departments-changed"));
    document.dispatchEvent(new CustomEvent("audit-log-updated"));
}

async function disableDepartment(department) {
    if (
        !window.confirm(
            `Disable "${department.name}"?\n\nIts data will be preserved and it can be re-enabled later.`
        )
    ) {
        return;
    }

    try {
        await setDepartmentActive(department, false);
    } catch (error) {
        window.alert(
            "The Department could not be disabled.\n\n" +
            (error instanceof Error ? error.message : String(error))
        );
    }
}

async function enableDepartment(department) {
    try {
        await setDepartmentActive(department, true);
    } catch (error) {
        window.alert(
            "The Department could not be re-enabled.\n\n" +
            (error instanceof Error ? error.message : String(error))
        );
    }
}

export function initialiseDepartments() {
    dom.departmentsNavButton?.addEventListener("click", function () {
        loadDepartments();
    });

    dom.addDepartmentButton?.addEventListener("click", openDepartmentModal);
    dom.departmentForm?.addEventListener("submit", createDepartment);
    dom.closeDepartmentModalButton?.addEventListener("click", closeDepartmentModal);
    dom.cancelDepartmentButton?.addEventListener("click", closeDepartmentModal);

    dom.departmentModal?.addEventListener("click", function (event) {
        if (event.target === dom.departmentModal) {
            closeDepartmentModal();
        }
    });

    document.addEventListener("keydown", function (event) {
        if (
            event.key === "Escape" &&
            dom.departmentModal &&
            !dom.departmentModal.hidden
        ) {
            closeDepartmentModal();
        }
    });

    document.addEventListener(
        "device-department-availability-changed",
        function () {
            renderDepartments();
        }
    );

    window.addEventListener("online", function () {
        if (dom.departmentsSection && !dom.departmentsSection.hidden) {
            loadDepartments({ silent: true });
        }
    });

    window.addEventListener("offline", function () {
        if (dom.departmentsSection && !dom.departmentsSection.hidden) {
            setStatus("Departments is unavailable offline.", true);
        }
    });
}
