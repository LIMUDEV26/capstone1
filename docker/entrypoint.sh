#!/bin/sh
set -e

PORT="${PORT:-8080}"

# Railway may restart an existing writable container layer. Normalize Apache's
# MPM configuration on every boot so mod_php runs with prefork only.
rm -f /etc/apache2/mods-enabled/mpm_*.load /etc/apache2/mods-enabled/mpm_*.conf
ln -sf /etc/apache2/mods-available/mpm_prefork.load /etc/apache2/mods-enabled/mpm_prefork.load
ln -sf /etc/apache2/mods-available/mpm_prefork.conf /etc/apache2/mods-enabled/mpm_prefork.conf

# Railway mounts the persistent uploads volume after the image is built. Make
# sure the mount point exists and remains writable by Apache on every boot.
mkdir -p /var/www/html/capstone1/uploads
cp /usr/local/share/llb/uploads.htaccess /var/www/html/capstone1/uploads/.htaccess
chown -R www-data:www-data /var/www/html/capstone1/uploads

sed -i "s/Listen 80/Listen $PORT/" /etc/apache2/ports.conf
sed -i "s/\*:8080/*:$PORT/g" /etc/apache2/sites-available/000-default.conf
sed -i "s/_default_:8080/_default_:$PORT/g" /etc/apache2/sites-available/000-default.conf 2>/dev/null || true
echo "ServerName localhost" >> /etc/apache2/apache2.conf

exec apache2-foreground
