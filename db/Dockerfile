# Migration runner image: Flyway + this repo's SQL migrations, built and run by
# .github/workflows/deploy.yml as a one-off ECS Fargate task (RDS is not reachable from the
# GitHub runner). Runtime config comes from the task definition (ValueFarm.Infra
# staging/emailing.tf): FLYWAY_URL, FLYWAY_USER, FLYWAY_PASSWORD, FLYWAY_CONNECT_RETRIES.
FROM flyway/flyway:11
ENV FLYWAY_CLEAN_DISABLED=true \
    FLYWAY_VALIDATE_MIGRATION_NAMING=true
COPY migration /flyway/sql
CMD ["migrate"]
