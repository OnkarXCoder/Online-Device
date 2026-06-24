const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const { MongoStore } = require("connect-mongo");
const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const Razorpay = require("razorpay");

const app = express();

if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.error("FATAL: RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set");
}

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || "rzp_test_SNblsok03hryMM",
  key_secret: process.env.RAZORPAY_KEY_SECRET || "96qcijqxGoAqiZ2VannwJb0h"
});

/* ================= MIDDLEWARE ================= */

app.use(express.urlencoded({extended:true}));
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

/* ================= DYNAMIC PRODUCT IMAGES ================= */

app.get("/uploads/:filename", (req, res) => {
  const fp = path.join(__dirname, "..", "public", "uploads", req.params.filename);
  if (fs.existsSync(fp)) return res.sendFile(fp);
  const match = demoProducts.find(p => p.image === req.params.filename);
  if (match) {
    res.set("Content-Type", "image/svg+xml");
    return res.send(createSvgImage(match));
  }
  res.status(404).send("Image not found");
});

app.set("view engine","ejs");
app.set("views",path.join(__dirname, "..", "views"));

/* ================= DATABASE (Serverless Caching) ================= */

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/techfix_db";

let cached = global._mongooseCache;
if (!cached) {
  cached = global._mongooseCache = { conn: null, promise: null };
}

async function connectDB() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    cached.promise = mongoose.connect(MONGODB_URI).then((m) => m);
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

/* Initiate DB connection on cold start */
connectDB().catch(err => console.log("DB init error:", err.message));

/* ================= MODELS ================= */

const User = mongoose.model("User",new mongoose.Schema({
name:String,
email:{type:String,unique:true},
password:String,
phone:String,
city:String,
state:String,
pincode:String,
address:String,
role:{type:String,default:"user"}
}));

const Product = mongoose.model("Product",new mongoose.Schema({
name:String,
price:Number,
image:String,
description:String,
stock:{type:Number,default:0},
createdAt:{type:Date,default:Date.now}
}));

const Repair = mongoose.model("Repair",new mongoose.Schema({

userId:String,
name:String,
email:String,
phone:String,
deviceType:String,
brand:String,
model:String,
problemType:String,
issue:String,
urgency:String,
pickupRequired:String,
address:String,
image:String,

status:{type:String,default:"Requested"},
amount:{type:Number,default:0},
paymentStatus:{type:String,default:"Pending"},expectedDate:Date,
createdAt:{type:Date,default:Date.now}
}));

const Feedback = mongoose.model("Feedback",new mongoose.Schema({
userId:String,
name:String,
email:String,
rating:Number,
message:String,
createdAt:{type:Date,default:Date.now}
}));

const Order = mongoose.model("Order",new mongoose.Schema({
userId:String,
name:String,
email:String,
products:[{
name:String,
price:Number,
image:String
}],
total:Number,
paymentId:String,
paymentStatus:String,
createdAt:{type:Date,default:Date.now}
}));

/* ================= MULTER ================= */

const storage = multer.diskStorage({

destination:(req,file,cb)=>{
const dir = process.env.VERCEL ? "/tmp/uploads" : path.join(__dirname, "..", "public", "uploads");
cb(null, dir);
},

filename:(req,file,cb)=>{
cb(null,Date.now()+"-"+file.originalname);
}

});

const upload = multer({storage});

/* ================= SESSION ================= */

if(!process.env.MONGODB_URI){
console.error("FATAL: MONGODB_URI environment variable is not set");
}

const SESSION_SECRET = process.env.SESSION_SECRET || "techfix_secret";
if (!process.env.SESSION_SECRET) {
  console.warn("WARNING: SESSION_SECRET not set, using default (not secure for production)");
}

let sessionStore;
try {
sessionStore = new MongoStore({
mongoUrl: MONGODB_URI,
collectionName: "sessions"
});
} catch(err) {
console.error("MongoStore init failed, using MemoryStore:", err.message);
}

const sessionConfig = {
secret: SESSION_SECRET,
resave: false,
saveUninitialized: false
};
if (sessionStore) sessionConfig.store = sessionStore;

app.use(session(sessionConfig));

/* ================= ENSURE DB CONNECTION ================= */

app.use(async (req, res, next) => {
  try {
    await connectDB();
  } catch (err) {
    console.error("DB connection error in middleware:", err.message);
  }
  next();
});

app.use(async (req,res,next)=>{

res.locals.user = req.session.user || null;
res.locals.cartCount = req.session.cart ? req.session.cart.length : 0;

res.locals.notification = null;
res.locals.repairId = null;

/* 🔥 MAIN LOGIC */
if(req.session.user){

const repair = await Repair.findOne({
  userId: req.session.user._id.toString(),
  status: "Waiting for Payment"
});

if(repair){
  res.locals.notification = "Admin sent repair amount. Please complete payment.";
  res.locals.repairId = repair._id;
}

}

next();

});
app.get("/repair-checkout/:id", async(req,res)=>{

try{

if(!req.session.user) return res.redirect("/login");

const repair = await Repair.findById(req.params.id);

if(!repair){
return res.send("Repair not found");
}

/* 🔥 VERY IMPORTANT CHECK */
if(!repair.amount || repair.amount <= 0){
return res.send("Admin has not set repair amount yet");
}

/* CREATE ORDER */
const order = await razorpay.orders.create({

amount: repair.amount * 100,
currency: "INR",
receipt: "repair_" + Date.now()

});

/* ✅ CORRECT RESPONSE */
res.render("payment",{
orderId: order.id,
amount: repair.amount,
type: "product",
key: process.env.RAZORPAY_KEY_ID,
repairId: repair._id
});

}catch(err){

console.log(err);
res.send("Payment Error");

}

});
app.post("/payment-success", async(req,res)=>{

try{

const {paymentId, repairId} = req.body;

/* ================= REPAIR PAYMENT ================= */
if(repairId){

await Repair.findByIdAndUpdate(repairId,{
paymentStatus:"Paid",
status:"Approved"
});

return res.json({type:"repair"});
}

/* ================= PRODUCT PAYMENT ================= */

if(!req.session.user){
return res.json({success:false});
}

const cart = req.session.cart || [];

if(cart.length === 0){
return res.json({success:false});
}

/* CALCULATE TOTAL */
const total = cart.reduce((sum,item)=>sum+item.price,0);

/* SAVE ORDER 🔥 */
const newOrder = await Order.create({

userId: req.session.user._id,
name: req.session.user.name,
email: req.session.user.email,

products: cart,
total: total,

paymentId: paymentId,
paymentStatus: "Paid"

});

console.log("ORDER SAVED:", newOrder);

/* CLEAR CART */
req.session.cart = [];

res.json({type:"product", success:true});

}catch(err){

console.log("PAYMENT ERROR:", err);
res.json({success:false});

}

});
/* ================= ADMIN EDIT PRODUCT PAGE ================= */

app.get("/admin-edit-product/:id", isAdmin, async(req,res)=>{

try{

const product = await Product.findById(req.params.id);

if(!product){
return res.send("Product not found");
}

res.render("adminEditProduct",{product});

}catch(err){

console.log(err);
res.send("Edit page error");

}

});

/* ================= DEMO PRODUCTS ================= */

const demoProducts = [
  {
    name:"Wireless Bluetooth Earbuds",
    price:1299,
    image:"demo-earbuds.svg",
    description:"High-quality wireless earbuds with noise cancellation, 24hr battery life, and comfortable fit.",
    stock:50,
    color:"#1a73e8",
    icon:"\uD83C\uDFA7"
  },
  {
    name:"Tempered Glass Screen Guard",
    price:349,
    image:"demo-screen-guard.svg",
    description:"9H hardness tempered glass screen protector with oleophobic coating. Anti-scratch and anti-fingerprint.",
    stock:100,
    color:"#34a853",
    icon:"\uD83D\uDCF1"
  },
  {
    name:"USB-C Fast Charging Cable",
    price:249,
    image:"demo-usb-cable.svg",
    description:"Braided nylon USB-C cable with 60W fast charging support. Durable and tangle-free.",
    stock:200,
    color:"#ea4335",
    icon:"\uD83D\uDD0C"
  },
  {
    name:"Portable Power Bank 10000mAh",
    price:1999,
    image:"demo-powerbank.svg",
    description:"High-capacity 10000mAh power bank with dual USB output and fast charging. Compact and travel-friendly.",
    stock:30,
    color:"#fbbc04",
    icon:"\uD83D\uDD0B"
  },
  {
    name:"Wireless Optical Mouse",
    price:599,
    image:"demo-mouse.svg",
    description:"Ergonomic wireless mouse with 1600 DPI optical sensor, silent clicks, and USB receiver.",
    stock:75,
    color:"#ff6d01",
    icon:"\uD83D\uDDB1\uFE0F"
  },
  {
    name:"Laptop Cooling Pad",
    price:1499,
    image:"demo-cooling-pad.svg",
    description:"Dual fan laptop cooling pad with adjustable height and blue LED lighting. Keeps your laptop cool.",
    stock:25,
    color:"#46bdc6",
    icon:"\uD83D\uDCBB"
  },
  {
    name:"Smart WiFi LED Bulb",
    price:449,
    image:"demo-smart-bulb.svg",
    description:"9W WiFi-enabled smart LED bulb with 16 million colors, voice control, and scheduling. Works with Alexa and Google Home.",
    stock:60,
    color:"#9c27b0",
    icon:"\uD83D\uDCA1"
  },
  {
    name:"HDMI Cable 2 Meter",
    price:299,
    image:"demo-hdmi-cable.svg",
    description:"High-speed HDMI 2.0 cable supporting 4K resolution, HDR, and 60fps. Gold-plated connectors.",
    stock:150,
    color:"#607d8b",
    icon:"\uD83D\uDCFA"
  },
  {
    name:"Bluetooth Portable Speaker",
    price:1799,
    image:"demo-speaker.svg",
    description:"Powerful Bluetooth 5.0 speaker with deep bass, 12hr battery life, and IPX5 water resistance. Perfect for outdoor and indoor use.",
    stock:40,
    color:"#8e24aa",
    icon:"\uD83D\uDD0A"
  },
  {
    name:"Wireless Keyboard Combo",
    price:899,
    image:"demo-keyboard.svg",
    description:"Full-size wireless keyboard and mouse combo with quiet keys, ergonomic design, and USB receiver. Compatible with all operating systems.",
    stock:60,
    color:"#00acc1",
    icon:"\u2328\uFE0F"
  }
];

function createSvgImage(product){
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:${product.color};stop-opacity:0.7"/>
      <stop offset="100%" style="stop-color:${product.color};stop-opacity:1"/>
    </linearGradient>
  </defs>
  <rect width="400" height="400" rx="20" fill="url(#bg)"/>
  <circle cx="200" cy="160" r="70" fill="rgba(255,255,255,0.2)"/>
  <text x="200" y="182" text-anchor="middle" font-size="64">${product.icon}</text>
  <text x="200" y="290" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" fill="white" font-weight="bold">${product.name}</text>
  <text x="200" y="320" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" fill="rgba(255,255,255,0.8)">TechFix Store</text>
  <text x="200" y="345" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" fill="white" font-weight="bold">\u20B9${product.price}</text>
</svg>`;
}

/* ================= DEFAULT ADMIN & DEMO PRODUCTS ================= */

(async () => {
  try {
    await connectDB();
    const exists = await User.findOne({email:"admin@techfix.com"});
    if (!exists) {
      const hash = await bcrypt.hash("admin123", 10);
      await User.create({
        name:"Admin",
        email:"admin@techfix.com",
        password:hash,
        role:"admin"
      });
      console.log("Default Admin Created");
    }
    const upDir = path.join(__dirname, "..", "public", "uploads");
    if (!fs.existsSync(upDir)) { fs.mkdirSync(upDir, { recursive: true }); }
    for (const p of demoProducts) {
      const fp = path.join(upDir, p.image);
      if (!fs.existsSync(fp)) { fs.writeFileSync(fp, createSvgImage(p), "utf-8"); }
      const existing = await Product.findOne({ name: p.name });
      if (!existing) {
        await Product.create({
          name: p.name,
          price: p.price,
          image: "/uploads/" + p.image,
          description: p.description,
          stock: p.stock
        });
      }
    }
    console.log("Demo Products Synced");
  } catch(err) {
    console.log("Init error:", err.message);
  }
})();

app.post("/set-repair-price/:id", isAdmin, async(req,res)=>{

const {amount} = req.body;

await Repair.findByIdAndUpdate(req.params.id,{
  amount: amount,
  status:"Waiting for Payment"
});

res.redirect("/admin-dashboard");

});
/* ================= HOME ================= */

app.get("/", async (req, res) => {

  await connectDB();
  const products = await Product.find().sort({ createdAt: -1 }).lean();

  res.render("index", {
    products
  });

});

app.post("/approve-repair/:id", async(req,res)=>{

try{

await Repair.findByIdAndUpdate(req.params.id,{
status: "Approved",
paymentStatus: "Pay Later"
});

res.redirect("/my-repairs");

}catch(err){

console.log(err);
res.send("Approve error");

}

});

app.post("/remove-from-cart/:id", (req,res)=>{

if(!req.session.cart){
return res.redirect("/cart");
}

const productId = req.params.id;

req.session.cart = req.session.cart.filter(item => 
item._id.toString() !== productId
);

res.redirect("/cart");

});
app.post("/delete-product/:id", async (req,res)=>{

try{

const productId = req.params.id;

await Product.findByIdAndDelete(productId);

res.redirect("/admin-dashboard");

}catch(err){
console.log("Delete Error:", err);
res.send("Error deleting product");
}

});
/* ================= REGISTER ================= */

app.get("/register",(req,res)=>{
res.render("register",{error:null});
});

app.post("/register",async(req,res)=>{

const {name,email,password,confirm}=req.body;

if(password!==confirm)
return res.render("register",{error:"Passwords do not match"});

const hash=await bcrypt.hash(password,10);

try{

await User.create({
name,email,password:hash
});

res.redirect("/login");

}catch{

res.render("register",{error:"Email already exists"});

}

});

/* ================= LOGIN ================= */

app.get("/login",(req,res)=>{
res.render("login",{error:null});
});

app.post("/login", async(req,res)=>{

const {email,password}=req.body;

const user=await User.findOne({email});
if(!user) return res.render("login",{error:"Invalid Email"});

const valid=await bcrypt.compare(password,user.password);
if(!valid) return res.render("login",{error:"Invalid Password"});

req.session.user=user;

/* CHECK PAYMENT */
const repair = await Repair.findOne({
userId:user._id,
status:"Waiting for Payment"
});

if(repair){
req.session.notification = "Admin sent repair amount. Please complete payment.";
req.session.repairId = repair._id;
}else{
req.session.notification = null;
req.session.repairId = null;
}

res.redirect("/");
});
app.get("/logout",(req,res)=>{
req.session.destroy(()=>res.redirect("/"));
});

/* ================= CART ================= */

app.post("/add-to-cart/:id",async(req,res)=>{

if(!req.session.user)
return res.redirect("/login");

const product=await Product.findById(req.params.id);

if(!req.session.cart)
req.session.cart=[];

req.session.cart.push({

_id:product._id,
name:product.name,
price:product.price,
image:product.image

});

res.redirect("/");

});

app.get("/cart",(req,res)=>{

if(!req.session.user)
return res.redirect("/login");

const cart=req.session.cart||[];

const total=cart.reduce((sum,item)=>sum+item.price,0);

res.render("cart",{cart,total});

});

/* ================= REPAIR PAGE ================= */

app.get("/repair-request",(req,res)=>{

if(!req.session.user)
return res.redirect("/login");

res.render("repair");

});

/* ================= SUBMIT REPAIR ================= */

app.post("/repair-request", upload.any(), async(req,res)=>{

try{

if(!req.session.user)
return res.redirect("/login");

const data=req.body;

let imagePath="";

if(req.files && req.files.length>0){
imagePath="/uploads/"+req.files[0].filename;
}

await Repair.create({

userId:req.session.user._id,
name:req.session.user.name,
email:req.session.user.email,

phone:data.phone,

deviceType:data.deviceType,
brand:data.brand,
model:data.model,

problemType:data.problemType,
issue:data.issue,

urgency:data.urgency,
pickupRequired:data.pickupRequired,

address:data.address,

image:imagePath

});

res.redirect("/my-repairs");

}catch(err){

console.log(err);
res.send("Repair Error");

}

});

/* ================= UPDATE PRODUCT ================= */

app.post("/admin-update-product/:id", isAdmin, upload.single("imageFile"), async(req,res)=>{

try{

const {name,price,description,stock,imageUrl} = req.body;

let imagePath = imageUrl;

if(req.file){
imagePath = "/uploads/" + req.file.filename;
}

await Product.findByIdAndUpdate(req.params.id,{

name,
price,
description,
stock,
image:imagePath

});

res.redirect("/admin-dashboard");

}catch(err){

console.log(err);
res.send("Product update error");

}

});

/* ================= MY REPAIRS ================= */

app.get("/my-repairs",async(req,res)=>{

if(!req.session.user)
return res.redirect("/login");

const repairs=await Repair.find({
userId:req.session.user._id
}).sort({createdAt:-1});

res.render("myRepairs",{repairs});

});

/* ================= FEEDBACK ================= */

app.get("/get-feedback",async(req,res)=>{

const feedbacks=await Feedback.find().sort({createdAt:-1}).limit(20);

res.json(feedbacks);

});

app.post("/submit-feedback",async(req,res)=>{

if(!req.session.user)
return res.json({success:false});

const {rating,message}=req.body;

await Feedback.create({

userId:req.session.user._id,
name:req.session.user.name,
email:req.session.user.email,

rating,
message

});

res.json({success:true});

});
app.post("/checkout", async(req,res)=>{

try{

if(!req.session.user){
return res.redirect("/login");
}

const cart = req.session.cart || [];

if(cart.length === 0){
return res.redirect("/cart");
}

const total = cart.reduce((sum,item)=>sum+item.price,0);

/* CREATE ORDER */

const order = await razorpay.orders.create({

amount: total * 100,
currency: "INR",
receipt: "order_" + Date.now()

});

/* OPEN PAYMENT PAGE */

res.render("payment",{

orderId: order.id,
amount: total,
key: process.env.RAZORPAY_KEY_ID,
type: "product"
});

}catch(err){

console.log(err);
res.send("Checkout error");

}

});
/* ================= ORDER SUCCESS PAGE ================= */

app.get("/order-success", async (req,res)=>{

try{

if(!req.session.user)
return res.redirect("/login");

const cart = req.session.cart || [];

if(cart.length === 0){
return res.redirect("/");
}

/* CALCULATE TOTAL */
const total = cart.reduce((sum,item)=>sum+item.price,0);

/* SAVE ORDER */
const newOrder = await Order.create({

userId: req.session.user._id,
name: req.session.user.name,
email: req.session.user.email,

products: cart,
total: total,

paymentStatus: "Paid"

});

/* DEBUG */
console.log("ORDER SAVED:", newOrder);

/* CLEAR CART */
req.session.cart = [];

res.render("order-success");

}catch(err){
console.log("ORDER ERROR:", err);
res.send("Order saving failed");
}

});

/* ================= ADD PRODUCT ================= */

app.get("/admin-add-product", isAdmin, (req,res)=>{
res.render("adminAddProduct",{error:null});
});

app.post("/admin-add-product", isAdmin, upload.single("imageFile"), async(req,res)=>{

try{

const {name,price,description,stock,imageUrl} = req.body;

let imagePath="";

if(req.file){
imagePath="/uploads/"+req.file.filename;
}else if(imageUrl){
imagePath=imageUrl;
}

if(!name || !price || !description || !stock || !imagePath){
return res.render("adminAddProduct",{error:"All fields required"});
}

await Product.create({
name,
price,
description,
stock,
image:imagePath
});

res.redirect("/admin-dashboard");

}catch(err){
console.log(err);
res.send("Add Product Error");
}

});

app.get("/notifications", async(req,res)=>{

if(!req.session.user) return res.redirect("/login");

const repairs = await Repair.find({
userId:req.session.user._id,
status:"Waiting for Payment"
});

res.render("notifications",{repairs});

});

/* ================= ADMIN MIDDLEWARE ================= */

function isAdmin(req,res,next){

if(!req.session.user || req.session.user.role!=="admin")
return res.redirect("/admin-login");

next();

}

/* ================= ADMIN LOGIN ================= */

app.get("/admin-login",(req,res)=>{
res.render("adminLogin",{error:null});
});

app.post("/admin-login",async(req,res)=>{

const {email,password}=req.body;

const admin=await User.findOne({email});

if(!admin || admin.role!=="admin")
return res.render("adminLogin",{error:"Not Authorized"});

const valid=await bcrypt.compare(password,admin.password);

if(!valid)
return res.render("adminLogin",{error:"Wrong Password"});

req.session.user=admin;

res.redirect("/admin-dashboard");

});


const transporter = nodemailer.createTransport({

service:"gmail",

auth:{
user: process.env.EMAIL_USER,
pass: process.env.EMAIL_PASS
}

});

/* ================= UPDATE REPAIR STATUS ================= */

app.post("/update-status/:id", isAdmin, async(req,res)=>{

try{

const {status, expectedDate} = req.body;

const repair = await Repair.findById(req.params.id);

if(!repair){
return res.send("Repair not found");
}

repair.status = status;

if(expectedDate){
repair.expectedDate = expectedDate;
}

await repair.save();

/* SEND EMAIL */

try{

await transporter.sendMail({

from:"TechFix Service <nwon839@gmail.com>",

to:repair.email,

subject:"Your Repair Status Has Been Updated",

html:`

<h2>Repair Update</h2>

<p>Hello <b>${repair.name}</b>,</p>

<p>Your repair request for <b>${repair.deviceType}</b> has been updated.</p>

<p><b>Status:</b> ${status}</p>

<p><b>Expected Date:</b> ${expectedDate || "Not provided"}</p>

<p>Thank you for choosing <b>TechFix</b>.</p>

`

});

}catch(mailError){

console.log("Email sending failed:", mailError);

}

res.redirect("/admin-dashboard");

}catch(err){

console.log(err);
res.send("Status update error");

}

});

/* ================= ADMIN DASHBOARD ================= */

app.get("/admin-dashboard",isAdmin,async(req,res)=>{

const repairs=await Repair.find().sort({createdAt:-1});
const products=await Product.find().sort({createdAt:-1});
const orders=await Order.find().sort({createdAt:-1});

const totalUsers=await User.countDocuments();
const totalProducts=await Product.countDocuments();
const totalRepairs=await Repair.countDocuments();

res.render("adminDashboard",{

repairs,
products,
orders,

totalUsers,
totalProducts,
totalRepairs

});

});
/* ================= ACCEPT REPAIR ================= */

app.post("/accept-repair/:id", async(req,res)=>{

try{

await Repair.findByIdAndUpdate(req.params.id,{
status:"Pending"
});

res.redirect("/admin-dashboard");

}catch(err){

console.log(err);
res.send("Accept repair error");

}

});

/* ================= DELETE REPAIR ================= */

app.post("/delete-repair/:id",isAdmin,async(req,res)=>{

await Repair.findByIdAndDelete(req.params.id);

res.redirect("/admin-dashboard");

});

app.get("/pay-repair/:id", async(req,res)=>{

const repair = await Repair.findById(req.params.id);

res.render("repairPayment",{repair});

});
app.post("/repair-payment-success/:id", async(req,res)=>{

await Repair.findByIdAndUpdate(req.params.id,{
paymentStatus:"Paid",
status:"Approved"
});

res.redirect("/my-repairs");

});

/* ================= GLOBAL ERROR HANDLER ================= */

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).send("Error: " + (err.message || "Unknown error"));
});

/* ================= EXPORT FOR VERCEL ================= */

module.exports = app;
