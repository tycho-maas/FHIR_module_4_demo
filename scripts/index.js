import fs from 'fs';
import jose from 'node-jose';
import { randomUUID } from "crypto";
import axios from 'axios';
import hyperquest from 'hyperquest';
import ndjson from 'ndjson';
import nodemailer from 'nodemailer';
import schedule from 'node-schedule';

const clientId = "1def3e55-13f6-4dda-8f7b-c6ed395ac7d0";
const tokenEndpoint = "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token";
const fhirBaseUrl = "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4"
const groupId = "e3iabhmS8rsueyz7vaimuiaSmfGvi.QwjVXJANlPOgR83"

const createJWT = async (payload) => {
    const ks = fs.readFileSync('keys.json');
    const keystore = await jose.JWK.asKeyStore(ks.toString());
    const key = keystore.get({ use: "sig" });
    return jose.JWS.createSign({ compact: true, fields: { typ: 'JWT' } }, key)
        .update(JSON.stringify(payload))
        .final();
}

const generateExpiry = (minutes) => {
    return Math.round(new Date().getTime() + minutes * 60 * 1000) / 1000 // 4mins
}


const makeTokenRequest = async () => {
    const jwt = await createJWT({
        "iss": clientId,
        "sub": clientId,
        "aud": tokenEndpoint,
        "jti": randomUUID(),
        "exp": generateExpiry(4) // 4mins
    })

    const formParams = new URLSearchParams()
    formParams.set("grant_type", "client_credentials")
    formParams.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer")
    formParams.set("client_assertion", jwt)



    const tokenResponse = await axios.post(tokenEndpoint, formParams, {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        }
    })

    return tokenResponse.data;
}


const kickOffBulkDataExport = async (accessToken) => {
    const bulkKickoffResponse = await axios.get(`${fhirBaseUrl}/Group/${groupId}/$export?`, {
        params: {
            _type: 'patient,observation',
            _typeFilter: 'Observation?category=laboratory'
        },
        headers: {
            Accept: `application/fhir+json`,
            Authorization: `Bearer ${accessToken}`,
            Prefer: 'respond-async'
        }
    })

    return bulkKickoffResponse.headers.get('Content-Location')
}

const pollAndWaitForExport = async (url, accessToken, pollIntervalSecs) => {
    const response = await axios.get(url, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        }
    })
    if (response.status == 200) {
        return response.data
    } else {
        const progress = response.headers.get("X-Progress")
        const totalPatients = response.headers.get("X-Total-Count") || response.headers.get("X-Patient-Count")
        const intervalSeconds = pollIntervalSecs
        console.log(`Export in progress: ${progress || 'Status unknown'}${totalPatients ? ` - Total patients: ${totalPatients}` : ''} - Retrying in ${intervalSeconds} seconds...`)
        await new Promise(resolve => setTimeout(resolve, pollIntervalSecs * 1000))
        return await pollAndWaitForExport(url, accessToken, pollIntervalSecs)
    }

}
const processBulkResponse = async (bundleResponse, accessToken, type, fn) => {
    const filteredOutputs = bundleResponse.output?.filter((output) => output.type == type)
    const promises = filteredOutputs?.map((output) => {
        const url = output.url
        return new Promise((resolve, reject) => {
            const stream = hyperquest(url, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                }
            })
                .pipe(ndjson.parse())
                .on('data', (obj) => {
                    fn(obj)
                })
                .on('end', () => {
                    resolve()
                })
                .on('error', (err) => {
                    reject(err)
                })
        })
    })
    await Promise.all(promises)
    return
}


const checkIfObservationNormal = (resource) => {
    const value = resource?.valueQuantity?.value
    const unit = resource?.valueQuantity?.unit

    if (!resource?.referenceRange) {
        return { isNormal: false, reason: `No reference range found for observation.` }
    }
    const referenceRangeLow = resource?.referenceRange?.[0]?.low?.value
    const referenceRangeHigh = resource?.referenceRange?.[0]?.high?.value
    if (!value || !referenceRangeLow || !referenceRangeHigh) {
        return { isNormal: false, reason: `Incomplete data.` }
    }

    if (value >= referenceRangeLow && value <= referenceRangeHigh) {
        return { isNormal: true, reason: `Within reference range.` }
    } else {
        return { isNormal: false, reason: `Outside reference range. ` }
    }

}

const main = async () => {
    const tokenResponse = await makeTokenRequest()
    const accessToken = tokenResponse.access_token
    const contentLocation = await kickOffBulkDataExport(accessToken)
    const bulkDataResponse = await pollAndWaitForExport(contentLocation, accessToken, 5)

    const patients = {}
    await processBulkResponse(bulkDataResponse, accessToken, 'Patient', (resource) => {
        patients[`Patient/${resource.id}`] = resource
    })


    const sendEmail = async (body) => {
        const transporter = nodemailer.createTransport({
            host: 'smtp.ethereal.email',
            port: 587,
            auth: {
                user: 'deven36@ethereal.email',
                pass: 'CPxK1mkmUyTQqSAJqt'
            }
        });

        await transporter.sendMail(body).then(info => console.log(info))
        return
    }

    let abnormalObservations = ``
    let message = `Results of patients in sandbox (Date ${new Date().toLocaleDateString('en-GB')} ${new Date().toLocaleTimeString('en-GB', { hour12: false })})`
    let normalObseravations = ``

    await processBulkResponse(bulkDataResponse, accessToken, 'Observation', (resource) => {
        const { isNormal, reason } = checkIfObservationNormal(resource)
        const patient = patients[resource.subject.reference]
        const patientName = patient?.name?.[0]?.text || 'Unknown'

        if (isNormal) {
            normalObseravations += `Patient Name: ${patientName} (ID: ${patient?.id}) - ${resource.code.text}: ${resource?.valueQuantity?.value}. Reason: ${reason}\n`
        } else {
            abnormalObservations += `Patient Name: ${patientName} (ID: ${patient?.id}) - ${resource.code.text}: ${resource?.valueQuantity?.value}. Reason: ${reason}\n`
        }
    })


    message += `\n\nAbnormal Observations:\n${abnormalObservations}\n\nNormal Observations:\n${normalObseravations}`

    console.log(message)

    const emailAck = await sendEmail({
        from: '"Tycho Maas" <FHIRbootcamp@medblocks.com>', // sender address
        to: "FHIRrecipient@test.com", // list of receivers
        subject: `Lab reports on ${new Date().toLocaleDateString('en-GB')} ${new Date().toLocaleTimeString('en-GB', { hour12: false })}`, // Subject line
        text: message, // body
    })
    console.log("Email set:", emailAck)

}

// Schedule the main function to run every 24h at 7 in the morning
const job = schedule.scheduleJob('0 7 * * *', async () => {
    console.log('Running scheduled FHIR data export and email report...');
    try {
        await main();
        console.log('Sent email succesfully.');
    } catch (error) {
        console.error('Error in scheduled job:', error);
    }
});



