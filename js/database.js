import { bootstrapUsers, defaultProducts } from "./config.js";
import { state } from "./state.js";

const databaseName = "MerchTillDatabase";
const databaseVersion = 4;

export function openDatabase() {
    return new Promise(function (resolve, reject) {
        const request = indexedDB.open(databaseName, databaseVersion);

        request.onupgradeneeded = function (event) {
            const databaseInstance = event.target.result;
            const upgradeTransaction = event.target.transaction;

            if (!databaseInstance.objectStoreNames.contains("products")) {
                databaseInstance.createObjectStore("products", {
                    keyPath: "id"
                });
            }

            if (!databaseInstance.objectStoreNames.contains("sales")) {
                const salesStore = databaseInstance.createObjectStore("sales", {
                    keyPath: "id",
                    autoIncrement: true
                });
                salesStore.createIndex("date", "date", { unique: false });
                salesStore.createIndex("createdAt", "createdAt", { unique: false });
                salesStore.createIndex("sessionId", "sessionId", { unique: false });
            } else {
                const salesStore = upgradeTransaction.objectStore("sales");
                if (!salesStore.indexNames.contains("sessionId")) {
                    salesStore.createIndex("sessionId", "sessionId", { unique: false });
                }
            }

            if (!databaseInstance.objectStoreNames.contains("sessions")) {
                const sessionsStore = databaseInstance.createObjectStore("sessions", {
                    keyPath: "id",
                    autoIncrement: true
                });
                sessionsStore.createIndex("status", "status", { unique: false });
                sessionsStore.createIndex("openedAt", "openedAt", { unique: false });
            }

            if (!databaseInstance.objectStoreNames.contains("users")) {
                const usersStore = databaseInstance.createObjectStore("users", {
                    keyPath: "id",
                    autoIncrement: true
                });
                usersStore.createIndex("username", "username", { unique: true });
                usersStore.createIndex("role", "role", { unique: false });
                usersStore.createIndex("active", "active", { unique: false });
            }
        };

        request.onsuccess = function (event) {
            state.database = event.target.result;
            resolve(state.database);
        };

        request.onerror = function () {
            console.error("Could not open the database:", request.error);
            reject(request.error);
        };
    });
}

export function loadProductsFromDatabase() {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("products", "readonly");
        const request = transaction.objectStore("products").getAll();

        request.onsuccess = function () {
            state.products = request.result.sort(function (first, second) {
                return first.id - second.id;
            });
            resolve(state.products);
        };

        request.onerror = function () {
            reject(request.error);
        };
    });
}

function addDefaultProductsToDatabase() {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("products", "readwrite");
        const store = transaction.objectStore("products");

        defaultProducts.forEach(function (product) {
            store.put({ ...product });
        });

        transaction.oncomplete = resolve;
        transaction.onerror = function () {
            reject(transaction.error);
        };
    });
}

export function saveProductToDatabase(product) {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("products", "readwrite");
        const request = transaction.objectStore("products").put(product);

        request.onsuccess = function () {
            resolve(product);
        };
        request.onerror = function () {
            reject(request.error);
        };
    });
}

export function deleteProductFromDatabase(productId) {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("products", "readwrite");
        const request = transaction.objectStore("products").delete(productId);

        request.onsuccess = resolve;
        request.onerror = function () {
            reject(request.error);
        };
    });
}

export function saveCompletedSaleTransaction(sale, updatedProducts) {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction(
            ["products", "sales"],
            "readwrite"
        );

        const productStore = transaction.objectStore("products");
        const saleRequest = transaction.objectStore("sales").add(sale);
        let savedSaleId = null;

        updatedProducts.forEach(function (product) {
            productStore.put(product);
        });

        saleRequest.onsuccess = function () {
            savedSaleId = saleRequest.result;
        };

        transaction.oncomplete = function () {
            resolve(savedSaleId);
        };

        transaction.onerror = function () {
            reject(transaction.error);
        };

        transaction.onabort = function () {
            reject(transaction.error || new Error("Sale transaction aborted."));
        };
    });
}

export function loadSalesFromDatabase() {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("sales", "readonly");
        const request = transaction.objectStore("sales").getAll();

        request.onsuccess = function () {
            state.sales = request.result.sort(function (first, second) {
                return second.createdAt.localeCompare(first.createdAt);
            });
            resolve(state.sales);
        };

        request.onerror = function () {
            reject(request.error);
        };
    });
}

export function loadSessionsFromDatabase() {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("sessions", "readonly");
        const request = transaction.objectStore("sessions").getAll();

        request.onsuccess = function () {
            state.sessions = request.result.sort(function (a, b) {
                return b.openedAt.localeCompare(a.openedAt);
            });
            state.currentSession =
                state.sessions.find(function (session) {
                    return session.status === "open";
                }) || null;
            resolve(state.sessions);
        };

        request.onerror = function () {
            reject(request.error);
        };
    });
}

export function createSessionInDatabase(session) {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("sessions", "readwrite");
        const request = transaction.objectStore("sessions").add(session);

        request.onsuccess = function () {
            resolve(request.result);
        };
        request.onerror = function () {
            reject(request.error);
        };
    });
}

export function closeSessionInDatabase(session) {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("sessions", "readwrite");
        const request = transaction.objectStore("sessions").put(session);

        request.onsuccess = function () {
            resolve(session);
        };
        request.onerror = function () {
            reject(request.error);
        };
    });
}

export function loadUsersFromDatabase() {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("users", "readonly");
        const request = transaction.objectStore("users").getAll();

        request.onsuccess = function () {
            state.users = request.result.sort(function (first, second) {
                return first.username.localeCompare(second.username);
            });
            resolve(state.users);
        };

        request.onerror = function () {
            reject(request.error);
        };
    });
}

function addBootstrapUsersToDatabase() {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("users", "readwrite");
        const store = transaction.objectStore("users");

        bootstrapUsers.forEach(function (user) {
            store.add({ ...user });
        });

        transaction.oncomplete = resolve;
        transaction.onerror = function () {
            reject(transaction.error);
        };
    });
}

export function saveUserToDatabase(user) {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("users", "readwrite");
        const request = transaction.objectStore("users").put(user);

        request.onsuccess = function () {
            resolve(request.result);
        };
        request.onerror = function () {
            reject(request.error);
        };
    });
}

export function addUserToDatabase(user) {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("users", "readwrite");
        const request = transaction.objectStore("users").add(user);

        request.onsuccess = function () {
            resolve(request.result);
        };
        request.onerror = function () {
            reject(request.error);
        };
    });
}

export function deleteUserFromDatabase(userId) {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("users", "readwrite");
        const request = transaction.objectStore("users").delete(userId);

        request.onsuccess = resolve;
        request.onerror = function () {
            reject(request.error);
        };
    });
}

export async function initialiseProductDatabase() {
    await openDatabase();
    await loadProductsFromDatabase();

    if (state.products.length === 0) {
        await addDefaultProductsToDatabase();
        await loadProductsFromDatabase();
    }

    return state.products;
}

export async function initialiseUsersDatabase() {
    await loadUsersFromDatabase();

    if (state.users.length === 0) {
        await addBootstrapUsersToDatabase();
        await loadUsersFromDatabase();
    }

    return state.users;
}
