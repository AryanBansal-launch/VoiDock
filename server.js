import express from 'express';
import Docker from 'dockerode';


const docker = new Docker() ;

const managementApp = express();

managementApp.use(express.json());

const MANAGEMENT_APP_PORT = process.env.MANAGEMENT_APP_PORT || 8080;
const REVERSE_PROXY_HOST = process.env.REVERSE_PROXY_HOST ?? 'localhost';

function pullDockerImage(image, tag){
    return Promise((res,rej)=>{
        docker.pull(`${image}`, {tag}, (err)=>{
            if(err){
                rej(err);
            }
            else{
                return res(true);
            }
        })
    })
}

managementApp.get("/", (req,res)=>{
    return res.json({status : 'Management App is up and Running.'});
});

managementApp.post("/container", async (req, res) =>{
    const {image , tag} = req.body;

    const systemImages = await docker.listImages();

    let isExisitngImage = false;

    for(const image of systemImages){
        for(const tag of image.RepoTags){
            if(tag === `${image}:${tag}`){
                isExisitngImage = true;
                break;
            }
        }
        if (isExisitngImage){
            break;
        }
    }
    if (!isExisitngImage){
        await pullDockerImage(image,tag);
    }
    const container = await docker.createContainer({
        Image : `${image}:${tag}`,
        HostConfig:{
            AutoRemove: true
        }
    });
    await container.start();

    //TODO: ALSO connect this contianer to the host network

    const inspect = await container.inspect();

    return res.json({
        status : 'success',
        data:{
            containerName : inspect.Name,
            domain : `${inspect.Name}.${REVERSE_PROXY_HOST}`
        }
    })
});

managementApp.listen(MANAGEMENT_APP_PORT, () => {
    console.log(`Management API is running on PORT : ${MANAGEMENT_APP_PORT}`);
})