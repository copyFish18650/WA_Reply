require("dotenv").config();
const { MysqlStateDatabase } = require("../src/database");

const database = new MysqlStateDatabase({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "whatsapp_sales_ai",
  connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 4),
  ssl: process.env.MYSQL_SSL === "true" ? {} : undefined
});

try {
  const result = database.status();
  console.log(JSON.stringify({ ok: result.integrity === "ok", ...result }, null, 2));
  if (result.integrity !== "ok") process.exitCode = 1;
} finally {
  database.close();
}
