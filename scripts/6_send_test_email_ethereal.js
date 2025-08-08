import nodemailer from 'nodemailer'

const transporter = nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    auth: {
        user: 'deven36@ethereal.email',
        pass: 'CPxK1mkmUyTQqSAJqt'
    }
});

transporter.sendMail({
  from: '"Sidharth Ramesh 👻" <learn@medblocks.com>', // sender address
  to: "participant-bootcamp@test.com", // list of receivers
  subject: "Hello from FHIR Bootcamp 🔥", // Subject line
  html: "Your Patient Camila Lopez is <b>completely fine</b>.<br/>Or <em>is she?</em>", // html body
}).then(info => console.log(info))