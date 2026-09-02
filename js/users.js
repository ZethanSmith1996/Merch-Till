import { dom } from "./dom.js";
import { canManageUsers } from "./permissions.js";
import { escapeHTML } from "./utils.js";
import { getValidCloudAccessToken } from "./auth.js";

const MANAGE_USERS_URL =
    "https://zdxduhnfjebahfzuqttk.supabase.co/functions/v1/manage-users";

const roleLabels = {
    "master-admin": "Master Admin",
    admin: "Admin",
    staff: "Staff",
    training: "Training"
};

let cloudUsers = [];

function setUsersStatus(message) {
    const status = document.getElementById("cloud-users-status");

    if (status) {
        status.textContent = message;
    }
}

function renderCloudUsers() {
    if (!dom.usersTableBody || !dom.noUsersMessage) return;

    dom.usersTableBody.innerHTML = "";
    dom.noUsersMessage.hidden = cloudUsers.length > 0;

    cloudUsers.forEach(function (user) {
        const row = document.createElement("tr");

        const role =
            roleLabels[user.role] ||
            escapeHTML(user.role || "");

        const status =
            user.active === true
                ? "Active"
                : "Disabled";

        row.innerHTML = `
            <td>
                <strong>${escapeHTML(user.username || "")}</strong>
            </td>
            <td>${escapeHTML(user.email || "")}</td>
            <td>${role}</td>
            <td>${status}</td>
            <td>
                <span>Cloud managed</span>
            </td>
        `;

        dom.usersTableBody.appendChild(row);
    });
}

async function fetchCloudUsers() {
    if (!canManageUsers()) {
        cloudUsers = [];
        renderCloudUsers();
        return;
    }

    const refreshButton =
        document.getElementById("refresh-cloud-users-button");

    if (refreshButton) {
        refreshButton.disabled = true;
    }

    setUsersStatus("Loading cloud users…");

    try {
        if (!navigator.onLine) {
            throw new Error(
                "Users are unavailable offline. Connect to the internet and try again."
            );
        }

        const accessToken =
            await getValidCloudAccessToken();

        if (!accessToken) {
            throw new Error(
                "No valid cloud session was found. Log out and log back in as Master while online."
            );
        }

        const response = await fetch(
            MANAGE_USERS_URL,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization":
                        `Bearer ${accessToken}`
                },
                body: JSON.stringify({
                    action: "list-users"
                })
            }
        );

        const responseText =
            await response.text();

        let data = null;

        try {
            data = JSON.parse(responseText);
        } catch (error) {
            data = null;
        }

        if (!response.ok) {
            throw new Error(
                data?.details ||
                data?.message ||
                data?.error ||
                responseText ||
                `HTTP ${response.status}`
            );
        }

        cloudUsers =
            Array.isArray(data?.users)
                ? data.users
                : [];

        renderCloudUsers();

        setUsersStatus(
            `Cloud users loaded successfully (${cloudUsers.length}).`
        );

    } catch (error) {
        console.error(
            "Cloud users could not be loaded:",
            error
        );

        /*
         * Deliberately do not display the old local
         * IndexedDB user list as a fallback.
         *
         * User administration is cloud-only.
         */
        cloudUsers = [];
        renderCloudUsers();

        const message =
            error instanceof Error
                ? error.message
                : String(error);

        setUsersStatus(
            `Users unavailable: ${message}`
        );

    } finally {
        if (refreshButton) {
            refreshButton.disabled = false;
        }
    }
}

export function renderUsersTable() {
    return fetchCloudUsers();
}

export function initialiseUserManagement() {
    const refreshButton =
        document.getElementById("refresh-cloud-users-button");

    if (refreshButton) {
        refreshButton.addEventListener(
            "click",
            fetchCloudUsers
        );
    }
}
