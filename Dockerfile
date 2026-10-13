FROM node:22-bookworm-slim AS frontend-build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
ENV DEPLOY_STATIC=1
ENV NEXT_PUBLIC_STATIC_EXPORT=1
RUN npm run build

FROM php:8.2-apache

RUN apt-get update && apt-get install -y --no-install-recommends \
      libzip-dev \
      libpng-dev \
      libjpeg62-turbo-dev \
      libfreetype6-dev \
      libonig-dev \
      python3 \
      python3-xlrd \
    && docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j"$(nproc)" mysqli pdo_mysql mbstring fileinfo zip gd opcache \
    && rm -f /etc/apache2/mods-enabled/mpm_*.load /etc/apache2/mods-enabled/mpm_*.conf \
    && ln -s /etc/apache2/mods-available/mpm_prefork.load /etc/apache2/mods-enabled/mpm_prefork.load \
    && ln -s /etc/apache2/mods-available/mpm_prefork.conf /etc/apache2/mods-enabled/mpm_prefork.conf \
    && a2enmod rewrite headers deflate expires \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /var/www/html

COPY --from=frontend-build /app/out/ ./out/
COPY .htaccess ./.htaccess
COPY api/ ./capstone1/api/
COPY public/logo-ui.webp ./capstone1/public/logo-ui.webp
COPY scripts/convert_xls_to_csv.py ./capstone1/scripts/convert_xls_to_csv.py
COPY vendor/ ./capstone1/vendor/
COPY docker/api.htaccess.prod ./capstone1/api/.htaccess
COPY docker/uploads.htaccess.prod /usr/local/share/llb/uploads.htaccess
COPY docker/000-default.conf /etc/apache2/sites-available/000-default.conf
COPY docker/performance.conf /etc/apache2/conf-available/performance.conf
COPY docker/php-performance.ini /usr/local/etc/php/conf.d/zz-performance.ini
COPY docker/aiven-ca.pem /etc/ssl/certs/aiven-ca.pem
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN a2enconf performance \
    && chmod +x /usr/local/bin/entrypoint.sh \
    && chown -R www-data:www-data /var/www/html/capstone1

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["apache2-foreground"]
