# s3-db
Testing S3 as a read-only database with potentially hundreds of simultaneous queries.

Requires Node 8 or higher (async await)

Use a big machine!  (try c5.2xlarge)

*Install git and nvm / nodejs*

```
sudo yum install -y git
wget -qO- https://raw.githubusercontent.com/creationix/nvm/v0.33.2/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
nvm install node
```

*Create a separate folder and download the repo to each folder*

```
mkdir 1 2 3 4 5 6 7 8

cd 1
git clone https://github.com/royhobbstn/s3-db.git
cd s3-db
npm install
screen
node direct_to_s3.js al ak az ar ca co ct
```

etc...

*For each folder / screen session, use one of:*

```
node direct_to_s3.js al ak az ar ca co ct
node direct_to_s3.js de dc fl ga hi id il
node direct_to_s3.js in ia ks ky la me md
node direct_to_s3.js ma mi mn ms mo mt ne
node direct_to_s3.js nv nh nj nm ny nc nd
node direct_to_s3.js oh ok or pa pr ri sc
node direct_to_s3.js sd tn tx ut vt va wa
node direct_to_s3.js wv wi wy us
```