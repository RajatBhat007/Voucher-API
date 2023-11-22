const express = require("express");
const multer = require("multer");
const xlsx = require("xlsx");
const mysql = require("mysql2/promise");
const cors = require("cors");

const app = express();
const port = 3000;
app.use(cors({ origin: true }));

// MySQL database connection
const pool = mysql.createPool({
  host: "15.207.42.176",
  user: "Tgc-Rajat-BataDB",
  password: "Lmasd&6#",
  database: "bata",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Multer setup for handling file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Express middleware to parse JSON and handle CORS
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Function to convert Excel serial date to MySQL-compatible date string
function excelDateToMySQLDate(excelDate) {
  try {
    console.log("excelDate:", excelDate); // Add this line for logging

    if (typeof excelDate !== "number" || isNaN(excelDate)) {
      throw new Error("Invalid Excel date value");
    }

    const date = new Date((excelDate - 25569) * 86400 * 1000);
    if (isNaN(date.getTime())) {
      throw new Error("Invalid date after conversion");
    }

    return date.toISOString().split("T")[0];
  } catch (error) {
    console.error("Error converting Excel date:", error);
    throw new Error("Invalid Excel date value");
  }
}

// POST endpoint to create a customer
app.post("/createCustomer", async (req, res) => {
  try {
    const { id_organisation, campaign_id, customer_name, phone_number, level } =
      req.body;

    // Validate input parameters (you may want to add more validation)
    if (
      !id_organisation ||
      !campaign_id ||
      !customer_name ||
      !phone_number ||
      !level
    ) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    // Insert the new customer into the tbl_customers table
    const [result] = await pool.query(
      "INSERT INTO tbl_customers (id_organisation, campaign_id, customer_name, phone_number, level) VALUES (?, ?, ?, ?, ?)",
      [id_organisation, campaign_id, customer_name, phone_number, level]
    );

    res.status(200).json({
      message: "Customer created successfully",
      customerId: result.insertId,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST endpoint to upload Excel sheet and update database
// POST endpoint to upload Excel sheet and update database
app.post("/upload", upload.single("excelFile"), async (req, res) => {
  try {
    const fileBuffer = req.file.buffer;
    const fileName = req.file.originalname; // Get the original file name

    const workbook = xlsx.read(fileBuffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    // Assuming data is an array of arrays, where each inner array represents a row
    for (const row of data.slice(1)) {
      const [
        id_organisation,
        campaign_id,
        level,
        voucher_serial_number,
        excelDate, // Assuming the date is in the Excel format
      ] = row;

      const client_expiry_date = excelDateToMySQLDate(excelDate);

      // Insert file name along with other data
      await pool.query(
        "INSERT INTO tbl_voucher_details_log (id_organisation, campaign_id, level, voucher_serial_number, client_expiry_date, status, customer_name, phone_number, uploaded_date, id_file) VALUES (?, ?, ?, ?, ?, 'A', NULL, NULL, NOW(), ?)",
        [
          id_organisation,
          campaign_id,
          level,
          voucher_serial_number,
          client_expiry_date,
          fileName,
        ]
      );
    }

    res.status(200).json({
      message: "Excel sheet uploaded and database updated successfully",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET endpoint to retrieve uploaded values from the database
app.get("/getUploadedValues", async (req, res) => {
  try {
    const [uploadedValues] = await pool.query(
      "SELECT * FROM tbl_voucher_details_log"
    );
    res.status(200).json(uploadedValues);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST endpoint to redeem a voucher
app.post("/redeemVoucher", async (req, res) => {
  try {
    const { voucher_serial_number, level, customer_name, phone_number } =
      req.body;

    // Check if the customer has already redeemed a voucher
    const [existingRedemption] = await pool.query(
      "SELECT * FROM tbl_voucher_details_log WHERE customer_name = ? AND phone_number = ? AND status = 'R' LIMIT 1",
      [customer_name, phone_number]
    );

    if (existingRedemption.length > 0) {
      return res.status(400).json({
        error: "Customer has already redeemed a voucher",
      });
    }

    // Check if the voucher is available for redemption
    const [voucher] = await pool.query(
      "SELECT * FROM tbl_voucher_details_log WHERE voucher_serial_number = ? AND level = ? AND status = 'A' LIMIT 1",
      [voucher_serial_number, level]
    );

    if (voucher.length === 0) {
      return res.status(400).json({
        error: "Voucher not available for redemption or already redeemed",
      });
    }

    // Update the voucher status to 'R' and set customer_name and phone_number
    await pool.query(
      "UPDATE tbl_voucher_details_log SET status = 'R', customer_name = ?, phone_number = ? WHERE id_voucher = ?",
      [customer_name, phone_number, voucher[0].id_voucher]
    );

    res.status(200).json({ message: "Voucher redeemed successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST endpoint to assign vouchers to customers based on level
app.post("/assignVouchers", async (req, res) => {
  try {
    const { id_organisation, campaign_id } = req.body;

    // Get available vouchers for the specified id_organisation and campaign_id
    const [vouchers] = await pool.query(
      "SELECT * FROM tbl_voucher_details_log WHERE id_organisation = ? AND campaign_id = ? AND status = 'A'",
      [id_organisation, campaign_id]
    );

    if (vouchers.length === 0) {
      return res.status(400).json({
        error:
          "No available vouchers for the specified id_organisation and campaign_id",
      });
    }

    // Group vouchers by level
    const vouchersByLevel = {};
    vouchers.forEach((voucher) => {
      if (!vouchersByLevel[voucher.level]) {
        vouchersByLevel[voucher.level] = [];
      }
      vouchersByLevel[voucher.level].push(voucher);
    });

    // Assign vouchers to customers based on level
    for (const level in vouchersByLevel) {
      const [customers] = await pool.query(
        "SELECT * FROM tbl_customers WHERE id_organisation = ? AND campaign_id = ? AND level = ?",
        [id_organisation, campaign_id, level]
      );

      if (customers.length === 0) {
        continue; // No customers for this level
      }

      const customersWithVouchers = customers.filter(
        (customer) => !customer.phone_number
      );

      for (const customer of customersWithVouchers) {
        const matchingVouchers = vouchersByLevel[level];

        if (matchingVouchers.length === 0) {
          break; // No more available vouchers for this level
        }

        const selectedVoucher = matchingVouchers.pop();

        // Update customer with voucher details
        await pool.query(
          "UPDATE tbl_customers SET phone_number = ?, voucher_serial_number = ? WHERE id_customer = ?",
          [
            customer.phone_number,
            selectedVoucher.voucher_serial_number,
            customer.id_customer,
          ]
        );

        // Update voucher status to 'R'
        await pool.query(
          "UPDATE tbl_voucher_details_log SET status = 'R', customer_name = ?, phone_number = ? WHERE id_voucher = ?",
          [
            customer.customer_name,
            customer.phone_number,
            selectedVoucher.id_voucher,
          ]
        );
      }
    }

    res.status(200).json({
      message: "Vouchers assigned successfully",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST endpoint to automatically assign vouchers to customers based on level
app.post("/autoAssignVoucher", async (req, res) => {
  try {
    const { phone_number, customer_name, level, id_organisation, campaign_id } =
      req.body;

    // Check if the customer with the given phone number already has a voucher assigned for the specified id_organisation and campaign_id
    const [existingAssignment] = await pool.query(
      "SELECT * FROM tbl_voucher_details_log WHERE id_organisation = ? AND campaign_id = ? AND phone_number = ? AND status = 'R' LIMIT 1",
      [id_organisation, campaign_id, phone_number]
    );

    if (existingAssignment.length > 0) {
      return res.status(400).json({
        error:
          "Customer with the provided phone number already has a voucher assigned for the specified id_organisation and campaign_id",
        assignedVoucher: {
          voucher_serial_number: existingAssignment[0].voucher_serial_number,
        },
      });
    }

    // Get an available voucher with the same level as the customer
    const [matchingVoucher] = await pool.query(
      "SELECT * FROM tbl_voucher_details_log WHERE id_organisation = ? AND campaign_id = ? AND level = ? AND status = 'A' LIMIT 1",
      [id_organisation, campaign_id, level]
    );

    if (!matchingVoucher) {
      return res.status(400).json({
        error:
          "No available voucher for the specified criteria. Better luck next time!",
      });
    }

    // Update the voucher status to 'R' and set phone_number and customer_name
    await pool.query(
      "UPDATE tbl_voucher_details_log SET status = 'R', phone_number = ?, customer_name = ? WHERE id_voucher = ?",
      [phone_number, customer_name, matchingVoucher[0].id_voucher]
    );

    res.status(200).json({
      message: "Voucher assigned successfully",
      assignedVoucher: {
        voucher_serial_number: matchingVoucher[0].voucher_serial_number,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Better Luck next time" });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
