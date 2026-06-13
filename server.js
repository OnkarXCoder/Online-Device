const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const nodemailer = require("nodemailer");
const path = require("path");
const multer = require("multer");
const Razorpay = require("razorpay");
const app = express();
const PORT = 3000;
const razorpay = new Razorpay({
  key_id: "rzp_test_SNblsok03hryMM",
  key_secret: "96qcijqxGoAqiZ2VannwJb0h"
});
/* ================= MIDDLEWARE ================= */

app.use(express.urlencoded({extended:true}));
app.use(express.json());
app.use(express.static("public"));

app.set("view engine","ejs");
app.set("views",path.join(__dirname,"views"));

/* ================= DATABASE ================= */

mongoose.connect("mongodb://127.0.0.1:27017/techfix_db")
.then(()=>console.log("MongoDB Connected"))
.catch(err=>console.log(err));

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
cb(null,"public/uploads");
},

filename:(req,file,cb)=>{
cb(null,Date.now()+"-"+file.originalname);
}

});

const upload = multer({storage});

/* ================= SESSION ================= */

app.use(session({

secret:"techfix_secret",
resave:false,
saveUninitialized:false,

store:MongoStore.create({
mongoUrl:"mongodb://127.0.0.1:27017/techfix_db"
})

}));
app.use(async (req,res,next)=>{

res.locals.user = req.session.user || null;
res.locals.cartCount = req.session.cart ? req.session.cart.length : 0;

res.locals.notification = null;
res.locals.repairId = null;

/* 🔥 MAIN LOGIC */
if(req.session.user){

const repair = await Repair.findOne({
  userId: req.session.user._id.toString(),   // ✅ FIXED
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
key: "rzp_test_SNblsok03hryMM",
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

/* ================= DEFAULT ADMIN ================= */

mongoose.connection.once("open",async()=>{

const exists=await User.findOne({email:"admin@techfix.com"});

if(!exists){

const hash=await bcrypt.hash("admin123",10);

await User.create({

name:"Admin",
email:"admin@techfix.com",
password:hash,
role:"admin"

});

console.log("Default Admin Created");

}

});

app.post("/set-repair-price/:id", isAdmin, async(req,res)=>{

const {amount} = req.body;

await Repair.findByIdAndUpdate(req.params.id,{
  amount: amount,
  status:"Waiting for Payment"   // 🔥 IMPORTANT
});

res.redirect("/admin-dashboard");

});
/* ================= HOME ================= */

app.get("/", async (req, res) => {

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

/* 🔥 FIX ID COMPARISON */
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
key: "rzp_test_SNblsok03hryMM",
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
/* ================= CHECKOUT ================= */

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

/* Create Razorpay Order */

const order = await razorpay.orders.create({

amount: total * 100,
currency: "INR",
receipt: "order_" + Date.now()

});

/* Open Payment Page */

res.render("payment",{

orderId: order.id,
amount: total,
key: "rzp_test_SNblsok03hryMM",
type: "repair"   // ✅ ADD THIS
});

}catch(err){

console.log(err);
res.send("Checkout error");

}

});

/* ================= ADD PRODUCT ================= */

// Show Add Product Page
app.get("/admin-add-product", isAdmin, (req,res)=>{
res.render("adminAddProduct",{error:null});
});

// Save Product
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
user:"nwon839@gmail.com",
pass:"xzjh jrbh asyr fqty"
}

});

/* ================= UPDATE REPAIR STATUS ================= */

app.post("/update-status/:id", async(req,res)=>{

try{

const {status, expectedDate} = req.body;

/* Find Repair */

const repair = await Repair.findById(req.params.id);

if(!repair){
return res.send("Repair not found");
}

/* Update Status */

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

/* Redirect */

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
/* ================= UPDATE REPAIR STATUS ================= */

app.post("/update-status/:id",isAdmin,async(req,res)=>{

const {status,expectedDate} = req.body;

await Repair.findByIdAndUpdate(req.params.id,{

status:status,
expectedDate:expectedDate

});

res.redirect("/admin-dashboard");

});
/* ================= DELETE REPAIR ================= */

app.post("/delete-repair/:id",isAdmin,async(req,res)=>{

await Repair.findByIdAndDelete(req.params.id);

res.redirect("/admin-dashboard");

});
/* ================= SERVER ================= */

app.listen(PORT,()=>{
console.log(`Server running at http://localhost:${PORT}`);
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


