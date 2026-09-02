import { dom } from "./dom.js";
import { state } from "./state.js";
import {
    addUserToDatabase,
    deleteUserFromDatabase,
    loadUsersFromDatabase,
    saveUserToDatabase
} from "./database.js";
import { canManageUsers } from "./permissions.js";
import { escapeHTML } from "./utils.js";
import { getValidCloudAccessToken } from "./auth.js";

const roleLabels = {
    "master-admin": "Master Admin",
    admin: "Admin",
    staff: "Staff",
    training: "Training"
};

function requireMasterAdmin() {
    if (canManageUsers()) {
        return true;
    }

    window.alert("Only the Master Admin can manage users.");
    return false;
}

function currentUsername() {
    return sessionStorage.getItem("merchTillUsername") || "";
}

function getNextLocalIdFallback() {
    if (state.users.length === 0) return 1;
    return Math.max(...state.users.map(function (user) { return user.id || 0; })) + 1;
}

export function renderUsersTable() {
    if (!dom.usersTableBody || !dom.noUsersMessage) return;

    dom.usersTableBody.innerHTML = "";
    dom.noUsersMessage.hidden = state.users.length > 0;

    state.users.forEach(function (user) {
        const row = document.createElement("tr");
        const statusText = user.active ? "Active" : "Disabled";
        const protectedText = user.protected ? " · Protected" : "";

        row.innerHTML = `
            <td><strong>${escapeHTML(user.username)}</strong></td>
            <td>${roleLabels[user.role] || escapeHTML(user.role)}</td>
            <td>${statusText}${protectedText}</td>
            <td>
                <div class="product-actions">
                    <button type="button" class="edit-user-button">Edit</button>
                    <button type="button" class="delete-user-button">Delete</button>
                </div>
            </td>
        `;

        const editButton = row.querySelector(".edit-user-button");
        const deleteButton = row.querySelector(".delete-user-button");

        editButton.addEventListener("click", function () {
            openEditUserModal(user.id);
        });

        deleteButton.disabled = Boolean(user.protected) || user.username === currentUsername();
        deleteButton.addEventListener("click", function () {
            deleteUser(user.id);
        });

        dom.usersTableBody.appendChild(row);
    });
}

function openAddUserModal() {
    if (!requireMasterAdmin()) return;

    dom.userForm.reset();
    dom.editingUserIdInput.value = "";
    dom.userModalTitle.textContent = "Add User";
    dom.userPasswordInput.required = true;
    dom.userPasswordHelp.textContent = "A password is required for a new user.";
    dom.userActiveInput.checked = true;
    dom.userFormError.textContent = "";
    dom.userModal.hidden = false;
    dom.userUsernameInput.focus();
}

function openEditUserModal(userId) {
    if (!requireMasterAdmin()) return;

    const user = state.users.find(function (item) {
        return item.id === userId;
    });

    if (!user) return;

    dom.editingUserIdInput.value = String(user.id);
    dom.userUsernameInput.value = user.username;
    dom.userPasswordInput.value = "";
    dom.userPasswordInput.required = false;
    dom.userPasswordHelp.textContent = "Leave blank to keep the current password.";
    dom.userRoleInput.value = user.role;
    dom.userActiveInput.checked = Boolean(user.active);
    dom.userModalTitle.textContent = "Edit User";
    dom.userFormError.textContent = "";

    if (user.protected) {
        dom.userRoleInput.value = "master-admin";
        dom.userRoleInput.disabled = true;
        dom.userActiveInput.disabled = true;
        dom.userUsernameInput.disabled = true;
    } else {
        dom.userRoleInput.disabled = false;
        dom.userActiveInput.disabled = false;
        dom.userUsernameInput.disabled = false;
    }

    dom.userModal.hidden = false;
    dom.userPasswordInput.focus();
}

function closeUserModal() {
    dom.userModal.hidden = true;
    dom.userForm.reset();
    dom.editingUserIdInput.value = "";
    dom.userFormError.textContent = "";
    dom.userRoleInput.disabled = false;
    dom.userActiveInput.disabled = false;
    dom.userUsernameInput.disabled = false;
}

async function saveUser(event) {
    event.preventDefault();
    if (!requireMasterAdmin()) return;

    const editingId = Number(dom.editingUserIdInput.value);
    const username = dom.userUsernameInput.value.trim();
    const password = dom.userPasswordInput.value;
    const role = dom.userRoleInput.value;
    const active = dom.userActiveInput.checked;

    if (!username) {
        dom.userFormError.textContent = "Please enter a username.";
        return;
    }

    if (!editingId && !password) {
        dom.userFormError.textContent = "Please enter a password.";
        return;
    }

    const duplicate = state.users.find(function (user) {
        return (
            user.username.toLowerCase() === username.toLowerCase() &&
            user.id !== editingId
        );
    });

    if (duplicate) {
        dom.userFormError.textContent = "That username is already in use.";
        return;
    }

    try {
        if (editingId) {
            const user = state.users.find(function (item) {
                return item.id === editingId;
            });

            if (!user) {
                dom.userFormError.textContent = "The user could not be found.";
                return;
            }

            const updatedUser = {
                ...user,
                username: user.protected ? user.username : username,
                role: user.protected ? user.role : role,
                active: user.protected ? true : active
            };

            if (password) {
                updatedUser.password = password;
            }

            await saveUserToDatabase(updatedUser);
        } else {
            await addUserToDatabase({
                username,
                password,
                role,
                active,
                protected: false,
                localIdFallback: getNextLocalIdFallback()
            });
        }

        await loadUsersFromDatabase();
        closeUserModal();
        renderUsersTable();

    } catch (error) {
        console.error("User could not be saved:", error);
        dom.userFormError.textContent = "The user could not be saved.";
    }
}

async function deleteUser(userId) {
    if (!requireMasterAdmin()) return;

    const user = state.users.find(function (item) {
        return item.id === userId;
    });

    if (!user || user.protected || user.username === currentUsername()) {
        window.alert("This user cannot be deleted.");
        return;
    }

    const confirmed = window.confirm(
        `Delete \"${user.username}\"?\n\nThis cannot be undone.`
    );

    if (!confirmed) return;

    try {
        await deleteUserFromDatabase(user.id);
        await loadUsersFromDatabase();
        renderUsersTable();
    } catch (error) {
        console.error("User could not be deleted:", error);
        window.alert("The user could not be deleted.");
    }
}

async function createCloudTestUser() {
    if (!requireMasterAdmin()) return;

    const button = document.getElementById("create-cloud-test-user-button");
    const status = document.getElementById("cloud-user-test-status");
    const usernameInput = document.getElementById("cloud-test-username");
    const emailInput = document.getElementById("cloud-test-email");
    const passwordInput = document.getElementById("cloud-test-password");
    const roleInput = document.getElementById("cloud-test-role");

    if (
        !button ||
        !status ||
        !usernameInput ||
        !emailInput ||
        !passwordInput ||
        !roleInput
    ) {
        return;
    }

    const username = usernameInput.value.trim().toLowerCase();
    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;
    const role = roleInput.value;

    if (!username) {
        status.textContent = "ERROR: Enter a username.";
        return;
    }

    if (!email) {
        status.textContent = "ERROR: Enter an email address.";
        return;
    }

    if (password.length < 8) {
        status.textContent = "ERROR: Password must contain at least 8 characters.";
        return;
    }

    const confirmed = window.confirm(
        `Create the real cloud test user "${username}" as ${role}?`
    );

    if (!confirmed) return;

    button.disabled = true;
    status.textContent = "Creating cloud user…";

    try {
        const accessToken = await getValidCloudAccessToken();

        if (!accessToken) {
            throw new Error(
                "No valid cloud session was found. Log out, log back in as Master while online, then try again."
            );
        }

        const response = await fetch(
            "https://zdxduhnfjebahfzuqttk.supabase.co/functions/v1/manage-users",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${accessToken}`
                },
                body: JSON.stringify({
                    action: "create-user",
                    username,
                    email,
                    password,
                    role
                })
            }
        );

        const responseText = await response.text();
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

        const message =
            data?.message ||
            `Cloud user "${username}" created successfully.`;

        status.textContent = `SUCCESS: ${message}`;
        window.alert(
            `SUCCESS: ${message}\n\nNow check Supabase Authentication > Users and public.profiles.`
        );

        passwordInput.value = "";

    } catch (error) {
        console.error("Cloud user creation test failed:", error);
        const message = error instanceof Error ? error.message : String(error);
        status.textContent = `ERROR: ${message}`;
        window.alert(`ERROR: ${message}`);
    } finally {
        button.disabled = false;
    }
}



function escapeCloudUserHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

async function loadCloudUsersTest() {
    if (!requireMasterAdmin()) return;

    const button = document.getElementById("load-cloud-users-button");
    const status = document.getElementById("cloud-user-test-status");
    const results = document.getElementById("cloud-users-test-results");

    if (!button || !status || !results) return;

    button.disabled = true;
    status.textContent = "Loading cloud users…";
    results.style.display = "none";
    results.innerHTML = "";

    try {
        const accessToken = await getValidCloudAccessToken();

        if (!accessToken) {
            throw new Error(
                "No valid cloud session was found. Log out, log back in as Master while online, then try again."
            );
        }

        const response = await fetch(
            "https://zdxduhnfjebahfzuqttk.supabase.co/functions/v1/manage-users",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${accessToken}`
                },
                body: JSON.stringify({
                    action: "list-users"
                })
            }
        );

        const responseText = await response.text();
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

        const cloudUsers = Array.isArray(data?.users) ? data.users : [];

        if (cloudUsers.length === 0) {
            results.innerHTML = "<p>No cloud users were returned.</p>";
        } else {
            const rows = cloudUsers.map((user) => `
                <tr>
                    <td>${escapeCloudUserHtml(user.username || "")}</td>
                    <td>${escapeCloudUserHtml(user.email || "")}</td>
                    <td>${escapeCloudUserHtml(user.role || "")}</td>
                    <td>${user.active === true ? "Active" : "Inactive"}</td>
                </tr>
            `).join("");

            results.innerHTML = `
                <table class="products-table">
                    <thead>
                        <tr>
                            <th>Username</th>
                            <th>Email</th>
                            <th>Role</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            `;
        }

        results.style.display = "block";
        status.textContent =
            `SUCCESS: Loaded ${cloudUsers.length} cloud user${cloudUsers.length === 1 ? "" : "s"}.`;

    } catch (error) {
        console.error("Cloud user list test failed:", error);
        const message = error instanceof Error ? error.message : String(error);
        status.textContent = `ERROR: ${message}`;
        window.alert(`ERROR: ${message}`);
    } finally {
        button.disabled = false;
    }
}


export function initialiseUserManagement() {
    if (!dom.addUserButton) return;

    const createCloudTestUserButton =
        document.getElementById("create-cloud-test-user-button");

    if (createCloudTestUserButton) {
        createCloudTestUserButton.addEventListener("click", createCloudTestUser);
    }

    const loadCloudUsersButton =
        document.getElementById("load-cloud-users-button");

    if (loadCloudUsersButton) {
        loadCloudUsersButton.addEventListener("click", loadCloudUsersTest);
    }

    dom.addUserButton.addEventListener("click", openAddUserModal);
    dom.closeUserModalButton.addEventListener("click", closeUserModal);
    dom.cancelUserButton.addEventListener("click", closeUserModal);
    dom.userForm.addEventListener("submit", saveUser);

    dom.userModal.addEventListener("click", function (event) {
        if (event.target === dom.userModal) {
            closeUserModal();
        }
    });

    document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && !dom.userModal.hidden) {
            closeUserModal();
        }
    });
}
