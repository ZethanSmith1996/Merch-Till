import { currencyFormatter } from "./config.js";
import { dom } from "./dom.js";

let resolvePayment = null;
let currentTotal = 0;
let paymentLines = [];

const EPSILON = 0.005;


function roundMoney(value) {
    return Math.round(
        (Number(value) + Number.EPSILON) * 100
    ) / 100;
}


function paidAmount() {
    return roundMoney(
        paymentLines.reduce(
            function (sum, line) {
                return sum + line.amount;
            },
            0
        )
    );
}


function remainingAmount() {
    return Math.max(
        0,
        roundMoney(
            currentTotal -
            paidAmount()
        )
    );
}


function resetPaymentState() {
    paymentLines = [];

    if (dom.paymentError) {
        dom.paymentError.textContent = "";
    }

    if (dom.paymentChangeBox) {
        dom.paymentChangeBox.hidden = true;
    }

    renderPaymentModal();
}


function lineLabel(line) {
    return (
        line.method === "cash"
            ? "Cash"
            : "Card"
    );
}


function renderPaymentModal() {
    if (!dom.paymentModal) {
        return;
    }

    const paid =
        paidAmount();

    const remaining =
        remainingAmount();

    dom.paymentTotal.textContent =
        currencyFormatter.format(
            currentTotal
        );

    dom.paymentPaid.textContent =
        currencyFormatter.format(
            paid
        );

    dom.paymentRemaining.textContent =
        currencyFormatter.format(
            remaining
        );

    if (dom.paymentLines) {
        dom.paymentLines.hidden =
            paymentLines.length === 0;

        dom.paymentLines.innerHTML =
            paymentLines.map(
                function (line) {
                    return `
                        <div class="payment-line">
                            <span>${lineLabel(line)}</span>

                            <div>
                                <strong>${currencyFormatter.format(line.amount)}</strong>
                                ${
                                    line.change > 0
                                        ? `<small> · Change ${currencyFormatter.format(line.change)}</small>`
                                        : ""
                                }
                            </div>
                        </div>
                    `;
                }
            ).join("");
    }

    if (dom.resetPaymentButton) {
        dom.resetPaymentButton.hidden =
            paymentLines.length === 0;
    }

    if (
        dom.paymentAmount &&
        document.activeElement !==
            dom.paymentAmount
    ) {
        dom.paymentAmount.value =
            remaining > 0
                ? remaining.toFixed(2)
                : "";
    }
}


function finishPayment() {
    const cashLines =
        paymentLines.filter(
            function (line) {
                return line.method === "cash";
            }
        );

    const cardLines =
        paymentLines.filter(
            function (line) {
                return line.method === "card";
            }
        );

    const cashAmount =
        roundMoney(
            cashLines.reduce(
                function (sum, line) {
                    return sum + line.amount;
                },
                0
            )
        );

    const cardAmount =
        roundMoney(
            cardLines.reduce(
                function (sum, line) {
                    return sum + line.amount;
                },
                0
            )
        );

    const cashTendered =
        roundMoney(
            cashLines.reduce(
                function (sum, line) {
                    return sum + line.tendered;
                },
                0
            )
        );

    const changeDue =
        roundMoney(
            cashLines.reduce(
                function (sum, line) {
                    return sum + line.change;
                },
                0
            )
        );

    const method =
        cashAmount > 0 &&
        cardAmount > 0
            ? "split"
            : cashAmount > 0
                ? "cash"
                : "card";

    const result = {
        paymentMethod:
            method,
        cashAmount,
        cardAmount,
        cashTendered,
        changeDue,
        payments:
            paymentLines.map(
                function (line) {
                    return {
                        method:
                            line.method,
                        amount:
                            line.amount,
                        tendered:
                            line.tendered,
                        change:
                            line.change
                    };
                }
            )
    };

    if (dom.paymentChangeBox) {
        dom.paymentChangeBox.hidden =
            changeDue <= 0;

        dom.paymentChangeDue.textContent =
            currencyFormatter.format(
                changeDue
            );
    }

    closePaymentModal(
        result
    );
}


function paymentError(message) {
    if (dom.paymentError) {
        dom.paymentError.textContent =
            message;
    }
}


function takePayment(method) {
    paymentError("");

    const remaining =
        remainingAmount();

    const entered =
        roundMoney(
            Number(
                dom.paymentAmount?.value
            )
        );

    if (
        !Number.isFinite(entered) ||
        entered <= 0
    ) {
        paymentError(
            "Enter a valid payment amount."
        );

        return;
    }

    if (method === "card") {
        if (
            entered >
            remaining + EPSILON
        ) {
            paymentError(
                "A card payment cannot exceed the remaining balance."
            );

            return;
        }

        paymentLines.push({
            method: "card",
            amount:
                Math.min(
                    entered,
                    remaining
                ),
            tendered:
                Math.min(
                    entered,
                    remaining
                ),
            change: 0
        });
    } else {
        /*
         * Cash can exceed the remaining balance only when it completes the
         * sale. The amount applied to the sale is the remaining balance and
         * the difference is returned as change.
         */
        const applied =
            Math.min(
                entered,
                remaining
            );

        const change =
            entered > remaining
                ? roundMoney(
                    entered -
                    remaining
                )
                : 0;

        paymentLines.push({
            method: "cash",
            amount: applied,
            tendered: entered,
            change
        });
    }

    renderPaymentModal();

    if (
        remainingAmount() <=
        EPSILON
    ) {
        finishPayment();
        return;
    }

    if (dom.paymentAmount) {
        dom.paymentAmount.value =
            remainingAmount()
                .toFixed(2);

        dom.paymentAmount.focus();
        dom.paymentAmount.select();
    }
}


function closePaymentModal(
    result = null
) {
    if (!dom.paymentModal) {
        return;
    }

    dom.paymentModal.hidden = true;

    const resolver =
        resolvePayment;

    resolvePayment = null;

    if (resolver) {
        resolver(result);
    }
}


export function collectPayment(total) {
    if (!dom.paymentModal) {
        return Promise.resolve(null);
    }

    if (resolvePayment) {
        return Promise.resolve(null);
    }

    currentTotal =
        roundMoney(total);

    paymentLines = [];

    dom.paymentModal.hidden = false;

    resetPaymentState();

    if (dom.paymentAmount) {
        dom.paymentAmount.value =
            currentTotal.toFixed(2);

        window.setTimeout(
            function () {
                dom.paymentAmount.focus();
                dom.paymentAmount.select();
            },
            0
        );
    }

    return new Promise(
        function (resolve) {
            resolvePayment =
                resolve;
        }
    );
}


export function initialisePayments() {
    dom.paymentCashButton
        ?.addEventListener(
            "click",
            function () {
                takePayment(
                    "cash"
                );
            }
        );

    dom.paymentCardButton
        ?.addEventListener(
            "click",
            function () {
                takePayment(
                    "card"
                );
            }
        );

    dom.resetPaymentButton
        ?.addEventListener(
            "click",
            resetPaymentState
        );

    dom.cancelPaymentButton
        ?.addEventListener(
            "click",
            function () {
                closePaymentModal(
                    null
                );
            }
        );

    dom.closePaymentModalButton
        ?.addEventListener(
            "click",
            function () {
                closePaymentModal(
                    null
                );
            }
        );

    dom.paymentModal
        ?.addEventListener(
            "click",
            function (event) {
                if (
                    event.target ===
                    dom.paymentModal
                ) {
                    closePaymentModal(
                        null
                    );
                }
            }
        );

    document.addEventListener(
        "keydown",
        function (event) {
            if (
                event.key ===
                    "Escape" &&
                dom.paymentModal &&
                !dom.paymentModal.hidden
            ) {
                closePaymentModal(
                    null
                );
            }
        }
    );
}
