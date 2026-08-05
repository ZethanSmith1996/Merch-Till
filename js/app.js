import { initialiseAuthentication, validateSavedSession } from "./auth.js";
import {
    initialiseProductDatabase,
    initialiseUsersDatabase,
    loadSalesFromDatabase,
    loadSessionsFromDatabase
} from "./database.js";
import {
    initialiseNavigation,
    applyNavigationPermissions
} from "./navigation.js";
import {
    initialiseProductManagement,
    renderProductsTable
} from "./products.js";
import {
    initialiseTill,
    renderCart,
    renderTillProducts,
    refreshTillAvailability
} from "./till.js";
import {
    initialiseSessions,
    renderSessionStatus
} from "./sessions.js";
import {
    initialiseReports,
    renderReports
} from "./reports.js";
import {
    initialiseUserManagement,
    renderUsersTable
} from "./users.js";

function refreshProductDisplays() {
    renderTillProducts();
    renderProductsTable();
    renderCart();
}

function refreshRolePermissions() {
    applyNavigationPermissions();
    refreshTillAvailability();
    renderSessionStatus();
}

async function startApplication() {
    initialiseAuthentication();
    initialiseNavigation();
    initialiseTill();
    initialiseProductManagement();
    initialiseSessions();
    initialiseReports();
    initialiseUserManagement();

    document.addEventListener("products-changed", refreshProductDisplays);
    document.addEventListener("user-role-changed", refreshRolePermissions);

    try {
        await initialiseProductDatabase();
        await initialiseUsersDatabase();
        await loadSalesFromDatabase();
        await loadSessionsFromDatabase();

        validateSavedSession();
        refreshProductDisplays();
        renderUsersTable();
        applyNavigationPermissions();
        refreshTillAvailability();
        renderSessionStatus();
        renderReports();

    } catch (error) {
        console.error("Database could not be initialised:", error);
        window.alert("The till database could not be loaded.");
    }
}

startApplication();
