require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");
const { GoogleSpreadsheet } = require("google-spreadsheet");

// **Google Sheets Credentials (Environment Variables)**
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_SERVICE_ACCOUNT = require("./service-account.json");  // Google API credentials file
const doc = new GoogleSpreadsheet(SPREADSHEET_ID);

const app = express();
app.use(bodyParser.json());
app.use(cors());

let products = {};  // Store detected products
let clients = [];   // SSE clients
const weightThreshold = 5;  // Minimum weight change for update

// **Authenticate Google Sheets**
async function accessSheet() {
    await doc.useServiceAccountAuth(GOOGLE_SERVICE_ACCOUNT);
    await doc.loadInfo();
    return doc.sheetsByTitle["Customer Feedback"]; // Sheet name
}

// **1️⃣ SSE Real-Time Streaming**
app.get("/stream-products", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    clients.push(res);
    res.write(`data: ${JSON.stringify(getCurrentProducts())}\n\n`);

    req.on("close", () => {
        clients = clients.filter(client => client !== res);
    });
});

// **Helper Function: Broadcast Updates**
function broadcastUpdate() {
    const data = JSON.stringify(getCurrentProducts());
    clients.forEach(client => client.write(`data: ${data}\n\n`));
}

// **2️⃣ Fetch Valid Products**
function getCurrentProducts() {
    return Object.entries(products)
        .filter(([_, product]) => product.weight >= 2 && product.price >= 0)
        .map(([name, details]) => ({ name, ...details }));
}

// **3️⃣ Add or Update Product**
app.post("/product", (req, res) => {
    const { name, weight, price, freshness } = req.body;

    if (!name || weight === undefined || price === undefined || !freshness) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    if (weight < 0 || price < 0) {
        return res.status(400).json({ error: "Invalid product (negative weight or price)" });
    }

    if (products[name]) {
        const prevWeight = products[name].weight;
        if (Math.abs(weight - prevWeight) > weightThreshold) {
            products[name] = { weight, price, freshness };
            broadcastUpdate();
            return res.status(200).json({ message: "Product updated successfully" });
        } else {
            return res.status(200).json({ message: "No significant change in weight" });
        }
    } else {
        products[name] = { weight, price, freshness };
        broadcastUpdate();
        return res.status(200).json({ message: "Product added successfully" });
    }
});

// **4️⃣ Get Products**
app.get("/products", (req, res) => {
    res.status(200).json(getCurrentProducts());
});

// **5️⃣ Delete Product**
app.delete("/product/:name", (req, res) => {
    const { name } = req.params;

    if (products[name]) {
        delete products[name];
        broadcastUpdate();
        return res.status(200).json({ message: `Product ${name} deleted.` });
    }

    return res.status(404).json({ error: `Product ${name} not found.` });
});

// **6️⃣ Payment Confirmation & Digital Receipt**
app.post("/confirm-payment", async (req, res) => {
    const { email, amountPaid } = req.body;

    if (!email || !amountPaid) {
        return res.status(400).json({ error: "Missing email or amount" });
    }

    const purchasedItems = getCurrentProducts();
    if (purchasedItems.length === 0) {
        return res.status(400).json({ error: "No items found for the receipt." });
    }

    const receiptPath = `receipts/receipt_${Date.now()}.pdf`;

    try {
        await generatePDFReceipt(purchasedItems, amountPaid, receiptPath);
        await sendEmail(email, "Payment Successful - Receipt", "Your receipt is attached.", receiptPath);
        res.json({ message: "Payment confirmed, receipt sent via email." });
    } catch (error) {
        console.error("Error generating or sending receipt:", error);
        res.status(500).json({ error: "Failed to send receipt." });
    }
});

// **7️⃣ Store Customer Feedback in Google Sheets**
app.post("/feedback", async (req, res) => {
    const { rating, email } = req.body;
    
    if (!["happy", "neutral", "sad"].includes(rating)) {
        return res.status(400).json({ error: "Invalid rating" });
    }

    try {
        const sheet = await accessSheet();
        await sheet.addRow({ Email: email, Rating: rating });

        res.json({ message: "Feedback saved successfully" });
    } catch (error) {
        console.error("Error saving feedback:", error);
        res.status(500).json({ error: "Failed to save feedback" });
    }
});

// **8️⃣ Retrieve Customer Feedback**
app.get("/get-feedback", async (req, res) => {
    try {
        const sheet = await accessSheet();
        const rows = await sheet.getRows();
        const feedbackData = rows.map(row => ({ email: row.Email, rating: row.Rating }));
        res.json(feedbackData);
    } catch (error) {
        console.error("Error retrieving feedback:", error);
        res.status(500).json({ error: "Failed to retrieve feedback" });
    }
});

// **Helper: Generate PDF Receipt**
function generatePDFReceipt(items, amount, filePath) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument();
        const stream = fs.createWriteStream(filePath);
        
        doc.pipe(stream);
        doc.fontSize(20).text("Payment Receipt", { align: "center" });
        doc.moveDown();
        items.forEach(item => {
            doc.fontSize(14).text(`${item.name}: ₹${item.price}`);
        });
        doc.moveDown();
        doc.fontSize(16).text(`Total Paid: ₹${amount}`, { align: "right" });

        doc.end();
        stream.on("finish", resolve);
        stream.on("error", reject);
    });
}

// **Helper: Send Email**
async function sendEmail(to, subject, text, attachmentPath = null) {
    let transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_PASS
        }
    });

    let mailOptions = {
        from: process.env.GMAIL_USER,
        to,
        subject,
        text,
    };

    if (attachmentPath) {
        mailOptions.attachments = [{ filename: "Receipt.pdf", path: attachmentPath }];
    }

    return transporter.sendMail(mailOptions);
}

// **Start Server**
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
